import os
import json
import math
import socket
import threading
import time
import sys
import re
import uuid
import struct
import zlib
import tempfile
import numpy as np
from PIL import Image
from concurrent.futures import ThreadPoolExecutor
from collections import OrderedDict
from copy import deepcopy

MAX_BYTES = 512 * 1024 * 1024


def _read(f, size, end=None):
    if size < 0 or (end is not None and f.tell()+size > end):
        raise ValueError('Invalid PSD/PSB section boundary')
    data = f.read(size)
    if len(data) != size:
        raise ValueError('Truncated PSD/PSB composite')
    return data


def read_composite(path):
    with open(path, 'rb') as f:
        total = os.fstat(f.fileno()).st_size
        signature, version, _, channels, h, w, depth, mode = struct.unpack('>4sH6sHIIHH', _read(f, 26))
        if signature != b'8BPS' or version not in (1, 2):
            raise ValueError('Not a PSD/PSB file')
        if mode not in (1, 3) or depth not in (8, 16, 32):
            raise ValueError('PSB input requires RGB or grayscale, 8/16/32 bits')
        colors = 3 if mode == 3 else 1
        if not 1 <= w <= 300000 or not 1 <= h <= 300000 or not colors <= channels <= 56:
            raise ValueError('Invalid PSD/PSB dimensions/channels')
        expected = w * h * channels * (depth // 8)
        if expected > MAX_BYTES:
            raise ValueError('Composite exceeds 512 MiB; enable Resize for detector')
        # Color data, resources, layer/mask section. No reading layer pixel data.
        for fmt in ('>I', '>I', '>Q' if version == 2 else '>I'):
            size = struct.unpack(fmt, _read(f, struct.calcsize(fmt)))[0]
            if f.tell() + size > total:
                raise ValueError('Invalid PSD/PSB section length')
            f.seek(size, 1)
        compression = struct.unpack('>H', _read(f, 2))[0]
        count = w * h * colors * (depth // 8)
        if compression == 0:
            data = _read(f, count)
        elif compression == 1:
            lengths = np.frombuffer(_read(f, h * channels * (4 if version == 2 else 2)),
                                    dtype='>u4' if version == 2 else '>u2')
            n = int(lengths[:h * colors].sum())
            if n > MAX_BYTES or f.tell() + int(lengths.sum()) > total:
                raise ValueError('Invalid RLE byte counts')
            packed = _read(f, n)
            # PSD RLE is PackBits over byte rows, also for 16/32-bit pixels.
            data = Image.frombytes('L', (w * (depth // 8), h * colors),
                                   packed, 'packbits', 'L').tobytes()
        elif compression in (2, 3):
            packed = f.read(MAX_BYTES + 1)
            if len(packed) > MAX_BYTES:
                raise ValueError('ZIP composite input too large')
            codec = zlib.decompressobj()
            data = codec.decompress(packed, expected + 1)
            if len(data) != expected or not codec.eof or codec.unconsumed_tail or codec.unused_data:
                raise ValueError('Invalid ZIP composite size/stream')
            data = data[:count]
        else:
            raise ValueError('Unknown PSD/PSB compression')
        if len(data) != count:
            raise ValueError('Invalid composite byte count')
        rows = h * colors
        if compression == 3:
            if depth == 8:
                data = np.frombuffer(data, np.uint8).reshape(rows, w).cumsum(axis=1, dtype=np.uint8).tobytes()
            elif depth == 16:
                data = np.frombuffer(data, '>u2').reshape(rows, w).cumsum(axis=1, dtype=np.uint16).astype('>u2').tobytes()
            else:
                delta = np.frombuffer(data, np.uint8).reshape(rows, w * 4).cumsum(axis=1, dtype=np.uint8)
                data = delta.reshape(rows, 4, w).transpose(0, 2, 1).copy().tobytes()
        dtype = {8: np.uint8, 16: '>u2', 32: '>f4'}[depth]
        image = np.frombuffer(data, dtype).reshape(colors, h, w).transpose(1, 2, 0)
        if depth == 16:
            image = (image >> 8).astype(np.uint8)
        elif depth == 32:
            # Linear float RGB -> display sRGB for the detectors.
            image = np.nan_to_num(image, nan=0.0, posinf=1.0, neginf=0.0)
            image = np.clip(image, 0, 1)
            image = np.where(image <= .0031308, image * 12.92, 1.055 * image ** (1 / 2.4) - .055)
            image = np.rint(image * 255).astype(np.uint8)
        if colors == 1:
            image = np.repeat(image, 3, axis=2)
        return np.ascontiguousarray(image[:, :, ::-1])  # OpenCV BGR


def _layer_plane(data, w, h, depth, version, alpha=False):
    """Decode one raster channel (the RLE table is local to this channel)."""
    if len(data)<2 or depth not in (8,16,32) or w<=0 or h<=0 or w*h*(depth//8)>MAX_BYTES:
        raise ValueError('Invalid raster channel header or dimensions')
    compression = int.from_bytes(data[:2], 'big')
    expected = w*h*(depth//8)
    payload = data[2:]
    if compression == 0:
        raw = payload
    elif compression == 1:
        size = 4 if version == 2 else 2
        table_bytes = size*h
        if len(payload) < table_bytes:
            raise ValueError('Truncated layer RLE table')
        lengths = np.frombuffer(payload[:table_bytes], '>u4' if version == 2 else '>u2')
        if int(lengths.sum()) != len(payload)-table_bytes:
            raise ValueError('Invalid layer RLE byte counts')
        raw = Image.frombytes('L',(w*(depth//8),h),payload[table_bytes:],'packbits','L').tobytes()
    elif compression in (2,3):
        codec = zlib.decompressobj()
        raw = codec.decompress(payload,expected+1)
        if len(raw) != expected or not codec.eof or codec.unconsumed_tail or codec.unused_data:
            raise ValueError('Invalid layer ZIP stream')
    else:
        raise ValueError('Unknown layer compression')
    if len(raw) != expected:
        raise ValueError('Invalid raster channel size')
    if compression == 3:
        if depth == 8:
            raw = np.frombuffer(raw,np.uint8).reshape(h,w).cumsum(axis=1,dtype=np.uint8).tobytes()
        elif depth == 16:
            raw = np.frombuffer(raw,'>u2').reshape(h,w).cumsum(axis=1,dtype=np.uint16).astype('>u2').tobytes()
        else:
            delta = np.frombuffer(raw,np.uint8).reshape(h,w*4).cumsum(axis=1,dtype=np.uint8)
            raw = delta.reshape(h,4,w).transpose(0,2,1).copy().tobytes()
    plane = np.frombuffer(raw,{8:np.uint8,16:'>u2',32:'>f4'}[depth]).reshape(h,w)
    if depth == 16:
        return (plane >> 8).astype(np.uint8)
    if depth == 32:
        plane = np.clip(np.nan_to_num(plane,nan=0,posinf=1,neginf=0),0,1)
        if not alpha:
            plane = np.where(plane<=.0031308,plane*12.92,1.055*plane**(1/2.4)-.055)
        return np.rint(plane*255).astype(np.uint8)
    return plane


def _single_layer(f, offset, length, version, depth, mode, canvas_w, canvas_h):
    """Narrow fast path: one visible normal raster layer without a user mask.

    Return None for documents requiring general layer compositing. No layer tree
    rendering, smart object traversal or rasterization is performed here.
    """
    if length < 2:
        return None
    if offset+length>os.fstat(f.fileno()).st_size:
        raise ValueError('Invalid raster layer section boundary')
    end=offset+length
    read=lambda size: _read(f,size,end)
    f.seek(offset)
    if abs(struct.unpack('>h',read(2))[0]) != 1:
        return None
    top,left,bottom,right = struct.unpack('>iiii',read(16))
    w,h = right-left,bottom-top
    count = struct.unpack('>H',read(2))[0]
    if not 1<=count<=56 or w<=0 or h<=0 or w*h*count*(depth//8)>MAX_BYTES:
        raise ValueError('Invalid single raster layer dimensions')
    channels=[]
    for _ in range(count):
        cid = struct.unpack('>h',read(2))[0]
        size = struct.unpack('>Q' if version==2 else '>I',read(8 if version==2 else 4))[0]
        channels.append((cid,size))
    signature,blend = read(4),read(4)
    opacity,clipping,flags,_ = read(4)
    extra = struct.unpack('>I',read(4))[0]
    extra_start = f.tell()
    if extra<4 or extra_start+extra>offset+length:
        raise ValueError('Invalid raster layer extra data')
    mask_size = struct.unpack('>I',read(4))[0]
    if signature!=b'8BIM' or blend!=b'norm' or clipping or flags&2 or (flags&8 and flags&16):
        return None
    extra_end=extra_start+extra
    if mask_size:
        # Disabled masks do not affect appearance. Active masks need Photoshop
        # compositing, so never silently use the unmasked pixels.
        if mask_size>extra_end-f.tell():
            raise ValueError('Invalid raster layer mask length')
        mask=read(min(mask_size,18))
        if len(mask)<18 or not mask[17]&2:
            return None
        f.seek(mask_size-len(mask),1)
    if f.tell()+4>extra_end:
        raise ValueError('Invalid raster layer blending ranges')
    ranges_size=int.from_bytes(read(4),'big')
    if ranges_size>extra_end-f.tell():
        raise ValueError('Invalid raster layer blending range size')
    if ranges_size>8*(count+1):
        return None
    ranges=read(ranges_size)
    if ranges and (len(ranges)%8 or ranges!=b'\x00\x00\xff\xff\x00\x00\xff\xff'*(len(ranges)//8)):
        return None
    if f.tell()>=extra_end:
        raise ValueError('Missing raster layer name')
    name_size=read(1)[0]
    name_bytes=name_size+(-(name_size+1))%4
    if f.tell()+name_bytes>extra_end:
        raise ValueError('Invalid raster layer name')
    f.seek(name_bytes,1)
    fill=255
    unsupported={b'lrFX',b'lfx2',b'lmfx',b'vmsk',b'vsms',b'TySh',b'SoCo',b'GdFl',b'PtFl',
                 b'SoLd',b'SoLE',b'PlLd',b'levl',b'curv',b'hue2',b'brit',b'blnc',b'CgEd'}
    while f.tell()<extra_end:
        if extra_end-f.tell()<12:
            if any(read(extra_end-f.tell())):
                raise ValueError('Invalid raster layer tagged block padding')
            break
        sig,key=read(4),read(4)
        size=int.from_bytes(read(8 if sig==b'8B64' else 4),'big')
        at=f.tell()
        if sig not in (b'8BIM',b'8B64') or at+size+(size%2)>extra_end:
            raise ValueError('Invalid raster layer tagged block')
        if key in unsupported:
            return None
        if key==b'iOpa' and size:
            fill=read(1)[0]
        if key in (b'lsct',b'lsdk') and size>=4 and int.from_bytes(read(4),'big'):
            return None
        next_at=at+size+(size%2)
        f.seek(next_at)
        if extra_end-next_at>=6:
            probe=read(6)
            if probe[:2]==b'\0\0' and probe[2:] in (b'8BIM',b'8B64'):
                next_at+=2
        f.seek(next_at)
    f.seek(extra_end)
    if f.tell()+sum(size for _,size in channels)>offset+length:
        raise ValueError('Truncated raster layer channels')
    colors = 3 if mode==3 else 1
    if len(set(cid for cid,_ in channels))!=len(channels):
        raise ValueError('Duplicate raster channel IDs')
    if not set(range(colors)).issubset(cid for cid,_ in channels):
        return None
    planes={}
    for cid,size in channels:
        if cid in (*range(colors),-1):
            if size>MAX_BYTES or size<2:
                raise ValueError('Invalid raster channel length')
            planes[cid]=_layer_plane(read(size),w,h,depth,version,alpha=cid==-1)
        else:
            f.seek(size,1)
    rgb = np.stack([planes[i] for i in range(colors)],axis=2)
    if colors==1:
        rgb=np.repeat(rgb,3,axis=2)
    if -1 in planes or opacity!=255 or fill!=255:
        a=planes[-1].astype(np.uint32) if -1 in planes else np.full((h,w),255,np.uint32)
        a=(a*opacity*fill+32512)//65025
        a=a[:,:,None]
        rgb=((rgb.astype(np.uint32)*a+255*(255-a)+127)//255).astype(np.uint8)
    canvas=np.full((canvas_h,canvas_w,3),255,np.uint8)
    x0,y0,x1,y1=max(0,left),max(0,top),min(canvas_w,right),min(canvas_h,bottom)
    if x1>x0 and y1>y0:
        canvas[y0:y1,x0:x1]=rgb[y0-top:y1-top,x0-left:x1-left]
    return np.ascontiguousarray(canvas[:,:,::-1])


def read_detector_image(path):
    """Prefer the actual raster layer in fresh exports: merged data may be white."""
    with open(path,'rb') as f:
        total=os.fstat(f.fileno()).st_size
        signature,version,_,channels,h,w,depth,mode=struct.unpack('>4sH6sHIIHH',_read(f,26))
        if signature!=b'8BPS' or version not in (1,2):
            raise ValueError('Not a PSD/PSB file')
        if mode not in (1,3) or depth not in (8,16,32):
            raise ValueError('PSB input requires RGB or grayscale, 8/16/32 bits')
        if not 1<=w<=300000 or not 1<=h<=300000 or not (3 if mode==3 else 1)<=channels<=56 or w*h*max(channels,3)*(depth//8)>MAX_BYTES:
            raise ValueError('Composite exceeds 512 MiB or has invalid dimensions; enable Resize for detector')
        size=struct.unpack('>I',_read(f,4))[0]
        if f.tell()+size>total:raise ValueError('Invalid color section length')
        f.seek(size,1)
        resource_size=struct.unpack('>I',_read(f,4))[0]
        resource_end=f.tell()+resource_size
        if resource_end>total:raise ValueError('Invalid resource section length')
        has_merged=None
        while f.tell()<resource_end:
            if resource_end-f.tell()<12:
                if any(_read(f,resource_end-f.tell())):
                    raise ValueError('Invalid resource padding')
                break
            signature=_read(f,4,resource_end)
            resource_id=struct.unpack('>H',_read(f,2,resource_end))[0]
            n=_read(f,1,resource_end)[0]
            _read(f,n+((n+1)%2),resource_end)
            length=struct.unpack('>I',_read(f,4,resource_end))[0]
            at=f.tell()
            if signature!=b'8BIM' or at+length+(length%2)>resource_end:
                raise ValueError('Invalid image resource length/signature')
            if resource_id==1057:
                if length<5:raise ValueError('Invalid VersionInfo resource')
                version_info=_read(f,5,resource_end)
                has_merged=bool(version_info[4])
            f.seek(at+length+(length%2))
        f.seek(resource_end)
        long_size=8 if version==2 else 4
        fmt='>Q' if version==2 else '>I'
        section_size=struct.unpack(fmt,_read(f,long_size))[0]
        section_end=f.tell()+section_size
        if section_end>total:raise ValueError('Invalid layer/mask section length')
        candidates=[]
        if section_size:
            length=struct.unpack(fmt,_read(f,long_size,section_end))[0]
            start=f.tell()
            if start+length>section_end:raise ValueError('Invalid layer info length')
            if length:candidates.append((start,length))
            # Common RGB8 export: avoid parsing unrelated global metadata at all.
            # High-depth files must locate Lr16/Lr32 before trying the main proxy.
            if length and depth==8:
                try:
                    image=_single_layer(f,start,length,version,depth,mode,w,h)
                    if image is not None:return image
                except (ValueError,OSError,struct.error):
                    pass  # Try a confirmed real composite or report below.
            f.seek(start+length)
            if f.tell()<section_end:
                mask_size=struct.unpack('>I',_read(f,4,section_end))[0]
                if f.tell()+mask_size>section_end:raise ValueError('Invalid global mask length')
                f.seek(mask_size,1)
                while f.tell()<section_end:
                    if section_end-f.tell()<12:
                        if any(_read(f,section_end-f.tell())):
                            raise ValueError('Invalid additional layer padding')
                        break
                    sig,key=_read(f,4,section_end),_read(f,4,section_end)
                    if sig not in (b'8BIM',b'8B64'):
                        raise ValueError('Invalid additional layer signature')
                    big=sig==b'8B64' or version==2 and key in (b'LMsk',b'Lr16',b'Lr32',b'Layr',b'Mt16',b'Mt32',b'Mtrn',b'Alph',b'FMsk',b'lnk2',b'FEid',b'FXid',b'PxSD')
                    n=struct.unpack('>Q' if big else '>I',_read(f,8 if big else 4,section_end))[0]
                    at=f.tell()
                    if at+n+(n%2)>section_end:raise ValueError('Invalid additional layer info length')
                    if key=={8:b'Layr',16:b'Lr16',32:b'Lr32'}[depth]:
                        candidates.insert(0,(at,n))
                    next_at=at+n+(n%2)
                    # Photoshop also aligns global tagged blocks to four bytes.
                    # Accept two-byte padding when the next valid signature is
                    # there; never scan arbitrary payload bytes for a header.
                    f.seek(next_at)
                    if section_end-next_at>=6:
                        probe=_read(f,6,section_end)
                        if probe[:2]==b'\0\0' and probe[2:] in (b'8BIM',b'8B64'):
                            next_at+=2
                    f.seek(next_at)
        errors=[]
        for start,length in candidates:
            try:
                image=_single_layer(f,start,length,version,depth,mode,w,h)
                if image is not None:return image
            except (ValueError,OSError,struct.error) as exc:
                errors.append(str(exc))
    # A white placeholder can also exist without VersionInfo. Require an
    # affirmative real-merged flag when there are layers we cannot reproduce.
    if section_size and has_merged is not True:
        detail='; '.join(errors) if errors else 'masks, effects or unsupported layer structure'
        raise ValueError('PSB has no confirmed real merged image and its raster layer cannot be read: '+detail)
    if has_merged is False:
        raise ValueError('PSB has no real merged image or usable raster layer')
    return read_composite(path)



API_HOST = "127.0.0.1"
API_PORT_SEND = 6321       # Python -> JSX
API_PORT_LISTEN = 6320     # JSX -> Python
TIMEOUT = 15 * 60
SERVER_VERSION = "0.6.5"

# Models are installed with the private runtime, outside the Photoshop folder.
# sys.prefix points to the active venv when the server is started by launcher.vbs.
MODEL_DIR = os.path.join(sys.prefix, "models")
HUMAN_MODEL = os.path.join(MODEL_DIR, "human.onnx")
FACE_MODEL = os.path.join(MODEL_DIR, "face.onnx")

FACE_CONF = 0.60
FACE_NMS = 0.30
MASK_MIN_COMPONENT_FRAC = 0.00010
MASK_MAX_COVERAGE = 0.92

# Frame matching primarily uses the placement score calculated by JSX with
# the same geometry that will be applied in Photoshop. Face-count/area ranking
# is deliberately secondary. Ratio-only matching remains a compatibility
# fallback for malformed/older requests.
RATIO_WEIGHT = 12.0
SIZE_WEIGHT = 0.75

last_request_time = time.time()
active_requests = 0
analysis_requests = {}
activity_lock = threading.Lock()
model_lock = threading.Lock()
model_init_lock = threading.Lock()
_models = None
_model_error = None

# Small measurements only; no images, masks or model outputs remain in the cache.
analysis_cache = OrderedDict()
analysis_cache_lock = threading.Lock()
ANALYSIS_CACHE_LIMIT = 512


def valid_analysis_key(key):
    return isinstance(key, str) and 0 < len(key) <= 16384


def read_cached_analysis(key, portraits=False):
    if not valid_analysis_key(key):
        return None
    with analysis_cache_lock:
        entry = analysis_cache.get(key)
        if entry is None or (portraits and not entry[0]):
            return None
        analysis_cache.move_to_end(key)
        return deepcopy(entry[1])


def store_cached_analysis(key, info, portraits=False):
    if not valid_analysis_key(key) or info.get("error") or not info.get("bbox") or info.get("portrait_error"):
        return info
    w, h = info.get("width", 0), info.get("height", 0)
    if not (w > 0 and h > 0):
        return info
    value = deepcopy(info)
    value.pop("id", None)
    value["bbox"] = [v / (w if i % 2 == 0 else h) for i, v in enumerate(value["bbox"])]
    if value.get("visual_center_x") is not None:
        value["visual_center_x"] /= w
    p = value.get("portrait")
    if p:
        unit = math.sqrt(w * h)
        p["eye"] = [p["eye"][0] / w, p["eye"][1] / h]
        p["metrics"] = [v / unit for v in p["metrics"]]
        p["head"] = p.get("head", 0) / unit
        for k in ("head_top", "chin"):
            p[k] /= h
        for k in ("head_left", "head_right"):
            p[k] /= w
    value["width"], value["height"] = 1., 1.
    with analysis_cache_lock:
        # A plain-object request must not downgrade existing portrait measurements.
        previous = analysis_cache.get(key)
        if previous is None or portraits or not previous[0]:
            analysis_cache[key] = (bool(portraits), value)
        analysis_cache.move_to_end(key)
        while len(analysis_cache) > ANALYSIS_CACHE_LIMIT:
            analysis_cache.popitem(last=False)
    return deepcopy(value)


def _load_dependencies():
    try:
        import numpy as np
        import cv2
    except Exception as exc:
        raise RuntimeError(
            "AlignFit Python runtime is incomplete. Run install_runtime.bat. "
            "Required: numpy, opencv-python. Details: %s" % exc
        )
    return np, cv2


class HumanSegmenter:
    """OpenCV Zoo PPHumanSeg, CPU/OpenCV DNN."""

    def __init__(self, model_path, np, cv2):
        self.np = np
        self.cv2 = cv2
        self.net = cv2.dnn.readNet(model_path)
        self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
        self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
        self.mean = np.array([0.5, 0.5, 0.5], dtype=np.float32).reshape(1, 1, 3)
        self.std = np.array([0.5, 0.5, 0.5], dtype=np.float32).reshape(1, 1, 3)

    def mask(self, image_bgr):
        cv2 = self.cv2
        np = self.np
        h, w = image_bgr.shape[:2]
        image = cv2.resize(image_bgr, (192, 192), interpolation=cv2.INTER_AREA)
        image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        image = image.astype(np.float32, copy=False) / 255.0
        image = (image - self.mean) / self.std
        blob = cv2.dnn.blobFromImage(image)
        self.net.setInput(blob)
        output = self.net.forward()[0]
        # Match the official OpenCV Zoo post-processing: resize logits first,
        # then choose the winning class for each source-image pixel.
        logits = cv2.resize(
            output.transpose(1, 2, 0), (w, h), interpolation=cv2.INTER_LINEAR
        ).transpose(2, 0, 1)
        return np.argmax(logits, axis=0).astype(np.uint8)


class FaceDetector:
    def __init__(self, model_path, cv2):
        self.cv2 = cv2
        if not hasattr(cv2, "FaceDetectorYN"):
            raise RuntimeError("opencv-python is too old: cv2.FaceDetectorYN is unavailable")
        self.detector = cv2.FaceDetectorYN.create(
            model_path, "", (320, 320), FACE_CONF, FACE_NMS, 5000
        )

    def detect(self, image_bgr):
        h, w = image_bgr.shape[:2]
        self.detector.setInputSize((w, h))
        _ok, faces = self.detector.detect(image_bgr)
        if faces is None:
            return []
        result = []
        for face in faces:
            x, y, fw, fh = [float(v) for v in face[:4]]
            if fw > 1 and fh > 1:
                result.append([x, y, x + fw, y + fh])
        return result


def get_models():
    global _models, _model_error
    if _models is not None:
        return _models
    if _model_error is not None:
        raise RuntimeError(_model_error)

    # Several startup handshakes may arrive close together. Load the DNN models
    # exactly once; duplicate readNet()/FaceDetectorYN construction wastes memory
    # and can make the first launch much slower.
    with model_init_lock:
        if _models is not None:
            return _models
        if _model_error is not None:
            raise RuntimeError(_model_error)
        try:
            if not os.path.isfile(HUMAN_MODEL):
                raise RuntimeError("Model not found: %s" % HUMAN_MODEL)
            if not os.path.isfile(FACE_MODEL):
                raise RuntimeError("Model not found: %s" % FACE_MODEL)
            np, cv2 = _load_dependencies()
            human = HumanSegmenter(HUMAN_MODEL, np, cv2)
            faces = FaceDetector(FACE_MODEL, cv2)
            _models = (np, cv2, human, faces)
            return _models
        except Exception as exc:
            _model_error = str(exc)
            raise


def read_image(path, np, cv2):
    # np.fromfile + imdecode handles Windows paths containing non-ASCII characters.
    try:
        data = np.fromfile(path, dtype=np.uint8)
        if data.size == 0:
            return None
        return cv2.imdecode(data, cv2.IMREAD_COLOR)
    except Exception:
        return None


def union_boxes(boxes):
    if not boxes:
        return None
    return [
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    ]


def clamp_bbox(box, w, h):
    if box is None:
        return None
    x1, y1, x2, y2 = [float(v) for v in box]
    x1 = max(0.0, min(float(w), x1))
    y1 = max(0.0, min(float(h), y1))
    x2 = max(0.0, min(float(w), x2))
    y2 = max(0.0, min(float(h), y2))
    if x2 - x1 < 2 or y2 - y1 < 2:
        return None
    return [x1, y1, x2, y2]


def _median(values):
    values = sorted(float(v) for v in values)
    n = len(values)
    if not n:
        return None
    m = n // 2
    return values[m] if n % 2 else (values[m - 1] + values[m]) * 0.5


def _bbox_gap(a, b):
    """Euclidean gap between two axis-aligned boxes; zero when they overlap."""
    dx = max(float(a[0]) - float(b[2]), float(b[0]) - float(a[2]), 0.0)
    dy = max(float(a[1]) - float(b[3]), float(b[1]) - float(a[3]), 0.0)
    return math.hypot(dx, dy)


def _human_components(mask, np, cv2):
    """Return retained connected human-mask components with geometry metadata."""
    h, w = mask.shape[:2]
    binary = (mask > 0).astype(np.uint8)
    foreground = int(binary.sum())
    if foreground <= 0:
        return []
    if float(foreground) / float(max(1, w * h)) > MASK_MAX_COVERAGE:
        return []

    num, _labels, stats, centroids = cv2.connectedComponentsWithStats(binary, 8)
    min_area = max(20, int(round(w * h * MASK_MIN_COMPONENT_FRAC)))
    out = []
    for i in range(1, num):
        x, y, cw, ch, area = [int(v) for v in stats[i]]
        if area < min_area or cw < 3 or ch < 3:
            continue
        out.append({
            "bbox": [float(x), float(y), float(x + cw), float(y + ch)],
            "area": float(area),
            "center_x": float(centroids[i][0]),
            "center_y": float(centroids[i][1]),
        })
    return out


def _associate_face(face, components):
    """Associate a face with the nearest plausible human component."""
    if not components:
        return None
    fx1, fy1, fx2, fy2 = [float(v) for v in face]
    fw = max(1.0, fx2 - fx1)
    fh = max(1.0, fy2 - fy1)
    cx = (fx1 + fx2) * 0.5
    cy = (fy1 + fy2) * 0.5
    best = None
    best_score = None
    for i, comp in enumerate(components):
        x1, y1, x2, y2 = comp["bbox"]
        # Segmentation can trim hair/head edges, so allow a face-sized halo.
        pad_x = max(6.0, fw * 0.75, (x2 - x1) * 0.05)
        pad_y = max(6.0, fh * 1.00, (y2 - y1) * 0.05)
        if not (x1 - pad_x <= cx <= x2 + pad_x and y1 - pad_y <= cy <= y2 + pad_y):
            continue
        ccx = (x1 + x2) * 0.5
        ccy = (y1 + y2) * 0.5
        score = ((cx - ccx) / max(1.0, x2 - x1)) ** 2 + ((cy - ccy) / max(1.0, y2 - y1)) ** 2
        if best_score is None or score < best_score:
            best = i
            best_score = score
    return best


def _filter_main_group(components, face_boxes, image_w, image_h):
    """Conservatively remove obvious small/detached background people.

    The filter is intentionally cautious: comparable-size people are always kept.
    Only components that are both small relative to the main group and spatially
    detached are candidates for removal. Face size provides a second depth cue.
    """
    if not components:
        return [], []
    if len(components) == 1 and not face_boxes:
        return components, []

    largest_area = max(c["area"] for c in components)
    face_info = []
    for face in face_boxes or []:
        fx1, fy1, fx2, fy2 = [float(v) for v in face]
        fh = max(1.0, fy2 - fy1)
        face_info.append({"box": [fx1, fy1, fx2, fy2], "height": fh, "component": _associate_face(face, components)})

    # Use the upper half of detected face sizes as a robust foreground scale.
    heights = sorted((f["height"] for f in face_info), reverse=True)
    upper = heights[:max(1, (len(heights) + 1) // 2)] if heights else []
    face_ref = _median(upper)
    main_face_min = (face_ref * 0.45) if face_ref else None

    core = set()
    largest_idx = max(range(len(components)), key=lambda i: components[i]["area"])
    core.add(largest_idx)
    for i, comp in enumerate(components):
        if comp["area"] >= largest_area * 0.15:
            core.add(i)
    if main_face_min is not None:
        for f in face_info:
            if f["component"] is not None and f["height"] >= main_face_min:
                core.add(f["component"])

    core_bbox = union_boxes([components[i]["bbox"] for i in sorted(core)])
    near_gap = max(12.0, max(float(image_w), float(image_h)) * 0.035)
    kept = set(core)
    for i, comp in enumerate(components):
        if i in kept:
            continue
        # Keep modest-size neighbours so a missed face in the main group does not
        # accidentally remove a real person standing close to the others.
        if comp["area"] >= largest_area * 0.04 and _bbox_gap(comp["bbox"], core_bbox) <= near_gap:
            kept.add(i)

    kept_components = [components[i] for i in sorted(kept)]
    kept_bbox = union_boxes([c["bbox"] for c in kept_components])

    filtered_faces = []
    for f in face_info:
        idx = f["component"]
        if idx is None or idx not in kept:
            continue
        # Tiny faces are the strongest sign of a distant background person.
        # On a substantial main component, keep them only when they are not an
        # extreme scale outlier. This also keeps face-count ranking stable.
        if face_ref is not None and len(face_info) > 1 and f["height"] < face_ref * 0.35:
            continue
        filtered_faces.append(f["box"])

    # If conservative filtering would remove every face, keep the best-sized face
    # that still belongs to a retained component rather than losing face guidance.
    if face_info and not filtered_faces:
        candidates = [f for f in face_info if f["component"] in kept]
        if candidates:
            best = max(candidates, key=lambda f: f["height"])
            filtered_faces = [best["box"]]

    return kept_components, filtered_faces


def human_geometry_from_mask(mask, np, cv2, face_boxes=None):
    """Return main-group envelope, foreground X center and filtered face boxes."""
    h, w = mask.shape[:2]
    components = _human_components(mask, np, cv2)
    if not components:
        return None, None, []

    if face_boxes:
        components, filtered_faces = _filter_main_group(components, face_boxes, w, h)
    else:
        filtered_faces = []
    if not components:
        return None, None, []

    kept_area = sum(c["area"] for c in components)
    weighted_x = sum(c["center_x"] * c["area"] for c in components)
    center_x = weighted_x / kept_area if kept_area > 0 else None
    return union_boxes([c["bbox"] for c in components]), center_x, filtered_faces


def visual_center_x(mask_bbox, mask_center_x, face_boxes, side_cropped=False):
    """Estimate a stable horizontal visual center for a person or a group.

    Normally the segmentation center of mass is the stable base and faces nudge
    it toward the perceptual center. If the human mask touches a side of the source
    image, bbox/mask symmetry is no longer trustworthy, so retained faces become
    the primary horizontal anchor.
    """
    if mask_bbox is None:
        return None

    x1, y1, x2, y2 = [float(v) for v in mask_bbox]
    bbox_center = (x1 + x2) * 0.5
    base = float(mask_center_x) if mask_center_x is not None and math.isfinite(float(mask_center_x)) else bbox_center

    bw = max(1.0, x2 - x1)
    bh = max(1.0, y2 - y1)
    pad_x = max(6.0, bw * 0.15)
    pad_y = max(6.0, bh * 0.20)
    centers = []
    for box in face_boxes or []:
        fx1, fy1, fx2, fy2 = [float(v) for v in box]
        cx = (fx1 + fx2) * 0.5
        cy = (fy1 + fy2) * 0.5
        if x1 - pad_x <= cx <= x2 + pad_x and y1 - pad_y <= cy <= y2 + pad_y:
            centers.append(cx)

    if centers:
        face_center = sum(centers) / float(len(centers))
        if side_cropped:
            # A side-cropped body has an incomplete mask/bbox. Faces are the most
            # reliable visible landmarks for the person's/group's perceived center.
            face_weight = 0.90 if len(centers) >= 2 else 0.85
        else:
            face_weight = 0.65 if len(centers) >= 2 else 0.55
        result = face_center * face_weight + base * (1.0 - face_weight)
    else:
        result = base

    return max(x1, min(x2, result))


class AnalysisCancelled(Exception):
    pass


def check_analysis_cancelled(cancel_event):
    if cancel_event is not None and cancel_event.is_set():
        raise AnalysisCancelled()


def analyze_image(path, portraits=False, cancel_event=None, image=None):
    check_analysis_cancelled(cancel_event)
    np, cv2, human_segmenter, face_detector = get_models()
    check_analysis_cancelled(cancel_event)
    if image is None:image = read_image(path, np, cv2)
    if image is None:
        raise RuntimeError("Cannot read preview: %s" % path)
    h, w = image.shape[:2]
    with model_lock:
        check_analysis_cancelled(cancel_event)
        human_mask = human_segmenter.mask(image)
        check_analysis_cancelled(cancel_event)
        face_detections = face_detector.detect(image)
    check_analysis_cancelled(cancel_event)

    portrait_mask, portrait_origin = human_mask, (0, 0)

    bbox, mask_center_x, face_boxes = human_geometry_from_mask(human_mask, np, cv2, face_detections)

    # Refine only the already-filtered main group. A small detached background
    # person therefore cannot unnecessarily enlarge the high-resolution crop.
    if bbox is not None and w >= 400 and h >= 300:
        bx1, by1, bx2, by2 = bbox
        margin_x = max(8.0, (bx2 - bx1) * 0.12)
        margin_y = max(8.0, (by2 - by1) * 0.12)
        cx1 = max(0, int(math.floor(bx1 - margin_x)))
        cy1 = max(0, int(math.floor(by1 - margin_y)))
        cx2 = min(w, int(math.ceil(bx2 + margin_x)))
        cy2 = min(h, int(math.ceil(by2 + margin_y)))
        if (cx2 - cx1 >= 32 and cy2 - cy1 >= 32 and
                (cx1 > 0 or cy1 > 0 or cx2 < w or cy2 < h)):
            crop = image[cy1:cy2, cx1:cx2]
            with model_lock:
                check_analysis_cancelled(cancel_event)
                refined_mask = human_segmenter.mask(crop)
            check_analysis_cancelled(cancel_event)
            local_faces = []
            for fx1, fy1, fx2, fy2 in face_boxes:
                if fx2 < cx1 or fx1 > cx2 or fy2 < cy1 or fy1 > cy2:
                    continue
                local_faces.append([fx1 - cx1, fy1 - cy1, fx2 - cx1, fy2 - cy1])
            refined, refined_center_x, refined_faces = human_geometry_from_mask(
                refined_mask, np, cv2, local_faces
            )
            if refined is not None:
                portrait_mask, portrait_origin = refined_mask, (cx1, cy1)
                bbox = [
                    refined[0] + cx1,
                    refined[1] + cy1,
                    refined[2] + cx1,
                    refined[3] + cy1,
                ]
                if refined_center_x is not None:
                    mask_center_x = refined_center_x + cx1
                if refined_faces:
                    face_boxes = [[f[0] + cx1, f[1] + cy1, f[2] + cx1, f[3] + cy1] for f in refined_faces]

    # A mask touching either side of the source image is an open/cropped shape.
    # In that case its rectangular center is biased by the missing body area, so
    # retained face positions become the dominant horizontal-center cue.
    side_tol = max(2.0, float(w) * 0.0025)
    side_cropped = bool(
        bbox is not None and (float(bbox[0]) <= side_tol or float(w) - float(bbox[2]) <= side_tol)
    )
    visual_x = visual_center_x(bbox, mask_center_x, face_boxes, side_cropped)

    # Face boxes may restore a head/hair edge trimmed by segmentation, but only
    # faces retained as part of the main group are allowed to expand the envelope.
    if bbox is not None and face_boxes:
        bbox = union_boxes([bbox] + face_boxes)

    bbox = clamp_bbox(bbox, w, h)
    # Preserve source-edge evidence independently of the padded safety envelope.
    bottom_gap_ratio = (max(0.0, float(h) - float(bbox[3])) / float(h)) if bbox is not None else None
    if bbox is not None:
        pad_x = max(1.0, w * 0.004)
        pad_top = max(1.0, h * 0.004)
        pad_bottom = max(1.0, h * 0.006)
        bbox = clamp_bbox(
            [bbox[0] - pad_x, bbox[1] - pad_top, bbox[2] + pad_x, bbox[3] + pad_bottom],
            w,
            h,
        )

    if bbox is not None:
        if visual_x is None or not math.isfinite(float(visual_x)):
            visual_x = (bbox[0] + bbox[2]) * 0.5
        visual_x = max(float(bbox[0]), min(float(bbox[2]), float(visual_x)))

    result = {
        "bbox": bbox,
        "faces": len(face_boxes),
        "visual_center_x": visual_x,
        "bottom_gap_ratio": bottom_gap_ratio,
        "width": int(w),
        "height": int(h),
    }

    # Nothing portrait-specific is loaded or computed unless explicitly requested.
    # Require one raw AND one retained detection: a group must not become a
    # portrait merely because a second small face was filtered out.
    if portraits and len(face_boxes) == 1 and len(face_detections) == 1 and bbox is not None:
        check_analysis_cancelled(cancel_event)
        try:
            result["portrait"] = portrait_measurements(image, face_boxes[0], bbox, np, cv2,
                portrait_mask, portrait_origin)
            if result["portrait"] is None:
                result["portrait_error"] = "Unreliable face landmarks"
        except Exception as exc:
            result["portrait_error"] = str(exc)
    return result



# Lazy imports keep the existing geometric/group workflow independent of
# MediaPipe. Initialization errors are cached, avoiding repeated failed loads.
_portrait_detector = None
_portrait_error = None
_portrait_lock = threading.Lock()


def portrait_head_top(mask, origin, box, eyes, forehead, fallback, np, cv2):
    """Measure the crown on the existing mask near this face, not the whole body."""
    if mask is None:
        return fallback
    x1, y1, x2, y2 = box
    fw, fh = x2-x1, y2-y1
    ox, oy = origin
    h, w = mask.shape[:2]
    left = max(0, int(math.floor(x1-fw*.25-ox)))
    right = min(w, int(math.ceil(x2+fw*.25-ox)))
    top = 0
    bottom = min(h, int(math.ceil(eyes[1]+fh*.15-oy)))
    if right <= left or bottom <= top:
        return fallback
    binary = (mask[top:bottom, left:right] > 0).astype(np.uint8)
    count, labels, _stats, _centers = cv2.connectedComponentsWithStats(binary, 8)
    if count <= 1:
        return fallback
    # Pick the component attached to the forehead/eye band. A detached raised
    # hand or segmentation speck above it must not become the crown.
    band_top = max(0, min(bottom-top-1, int(forehead-oy-top)))
    band_left = max(0, int(x1-ox-left))
    band_right = min(right-left, int(math.ceil(x2-ox-left)))
    if band_right <= band_left:
        return fallback
    votes = np.bincount(labels[band_top:, band_left:band_right].ravel(), minlength=count)
    votes[0] = 0
    label = int(votes.argmax())
    if votes[label] == 0:
        return fallback
    rows = np.count_nonzero(labels == label, axis=1) >= max(2, int(round(fw*.08)))
    sustained = np.flatnonzero(rows[:-1] & rows[1:])
    if not sustained.size:
        return fallback
    return max(0., min(float(forehead), float(oy+top+sustained[0])))


def contour_height(mask, eye, eye_span, np, cv2):
    """Conservative measurement in an eye-levelled local crop, or None."""
    h, w = mask.shape
    ex, ey = eye
    if eye_span < 16 or not (0 <= ex < w and 0 <= ey < h):
        return None
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    x0, x1 = max(0, int(ex - eye_span*.22)), min(w, int(ex + eye_span*.22)+1)
    y0, y1 = max(0, int(ey)), min(h, int(ey + eye_span*.3)+1)
    ids = labels[y0:y1, x0:x1].ravel()
    ids = ids[ids > 0]
    if not ids.size:
        return None
    label = int(np.bincount(ids).argmax())
    if stats[label, cv2.CC_STAT_TOP] <= 2:
        return None  # crop/image top touched: no reliable crown
    component = labels == label
    if np.mean(component[y0:y1, x0:x1]) < .85:
        return None
    tops = []
    for x in range(x0, x1):
        ys = np.flatnonzero(component[:min(h, int(ey)+1), x])
        if len(ys):
            tops.append(float(ys[0]))
    if len(tops) < .8 * (x1-x0):
        return None
    top = float(np.median(tops))
    height = ey - top
    if not .45 * eye_span < height < 1.6 * eye_span:
        return None
    if float(np.percentile(tops, 90)-np.percentile(tops, 10)) > .20 * eye_span:
        return None
    return float(height)


def portrait_head_height(mask, origin, points, np, cv2):
    """Eye-to-crown distance, levelled exactly as in Face alignment."""
    if mask is None:
        return 0.
    left, right = np.array(points[33]), np.array(points[263])
    eye = (left+right)*.5
    span = float(np.linalg.norm(right-left))
    if span < 20:
        return 0.
    axis = (right-left)/span
    down = np.array([-axis[1], axis[0]])
    unit = 100.
    local_eye = eye-np.array(origin)
    matrix = np.array([[axis[0]*unit/span, axis[1]*unit/span, 180.-np.dot(axis,local_eye)*unit/span],
                       [down[0]*unit/span, down[1]*unit/span, 200.-np.dot(down,local_eye)*unit/span]])
    # Validate the same measurement rectangle without allocating/warping a full
    # validity mask. An affine rectangle is valid when all four corners are.
    inverse = cv2.invertAffineTransform(matrix)
    corners = np.array([[125.,30.,1.],[235.,30.,1.],[125.,225.,1.],[235.,225.,1.]]) @ inverse.T
    h, w = mask.shape[:2]
    if (corners[:,0].min() < 0 or corners[:,1].min() < 0 or
            corners[:,0].max() > w-1 or corners[:,1].max() > h-1):
        return 0.
    patch = cv2.warpAffine(mask, matrix, (360,360), flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT)
    height = contour_height(patch, (180.,200.), unit, np, cv2)
    return height*span/unit if height is not None else 0.


def portrait_measurements(image, box, envelope, np, cv2, mask=None, mask_origin=(0, 0)):
    global _portrait_detector, _portrait_error
    with _portrait_lock:
        if _portrait_error:
            raise RuntimeError(_portrait_error)
        if _portrait_detector is None:
            try:
                import mediapipe as mp
                from mediapipe.tasks.python import BaseOptions, vision
                model = os.path.join(MODEL_DIR, "face_landmarker.task")
                if not os.path.isfile(model):
                    raise RuntimeError("face_landmarker.task missing; run install_runtime.bat")
                _portrait_detector = vision.FaceLandmarker.create_from_options(
                    vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=model),
                        running_mode=vision.RunningMode.IMAGE, num_faces=1,
                        output_face_blendshapes=False, output_facial_transformation_matrixes=False))
            except Exception as exc:
                _portrait_error = "Portrait analysis unavailable; run install_runtime.bat: %s" % exc
                raise RuntimeError(_portrait_error)
        import mediapipe as mp
        # Analyze a face crop for stable detail even on full-length photographs.
        h, w = image.shape[:2]
        x1, y1, x2, y2 = box
        pad = max(x2-x1, y2-y1) * .65
        ox, oy = max(0, int(x1-pad)), max(0, int(y1-pad))
        crop = image[oy:min(h, int(math.ceil(y2+pad))), ox:min(w, int(math.ceil(x2+pad)))]
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        detected = _portrait_detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
        if not detected.face_landmarks:
            return None
        ch, cw = crop.shape[:2]
        mesh = detected.face_landmarks[0]
        # Only these 11 points are used by the six metrics and composition.
        points = {i: [mesh[i].x*cw+ox, mesh[i].y*ch+oy]
            for i in (10, 33, 263, 133, 362, 234, 454, 127, 356, 152, 168)}
    def dist(a, b):
        return math.hypot(a[0]-b[0], a[1]-b[1])
    eyes = [(points[33][j]+points[263][j])*.5 for j in (0, 1)]
    if not (x1 <= eyes[0] <= x2 and y1 <= eyes[1] <= y2):
        return None
    metrics = [dist(points[33], points[263]), dist(points[133], points[362]),
        dist(points[234], points[454]), dist(points[127], points[356]),
        dist(eyes, points[152]), dist(points[168], points[152])]
    metrics = [v if math.isfinite(v) and v > 0 else 0. for v in metrics]
    if sum(math.isfinite(v) and v > 2 for v in metrics) < 4 or metrics[0] < 12:
        return None
    head_top = portrait_head_top(mask, mask_origin, box, eyes, points[10][1],
        max(0., min(float(envelope[1]), points[10][1])), np, cv2)
    try:
        head_height = portrait_head_height(mask, mask_origin, points, np, cv2)
    except Exception:
        # Optional contour uncertainty must never discard reliable face metrics.
        head_height = 0.
    return {"eye": eyes, "metrics": metrics,
        "head": head_height,
        "head_top": head_top,
        "chin": max(eyes[1]+1., points[152][1]),
        "head_left": max(0., min(box[0], points[234][0], points[127][0]) - metrics[0]*.15),
        "head_right": min(float(w), max(box[2], points[454][0], points[356][0]) + metrics[0]*.15)}


def facial_ratio(reference, measured, reference_head=0., measured_head=0.):
    """Face alignment portraitScale: robust face ratio and bounded head correction."""
    weights = [.25, .10, .15, .10, .25, .15]
    items = sorted((math.log(a/b), w) for a, b, w in zip(reference, measured, weights)
        if a > 2 and b > 2 and math.isfinite(a) and math.isfinite(b))
    if len(items) < 4 or not (reference[0] > 2 and measured[0] > 2):
        raise ValueError("Insufficient face measurements")
    acc, center = 0., items[0][0]
    half_weight = sum(w for _, w in items)*.5
    for value, weight in items:
        acc += weight
        if acc >= half_weight:
            center = value
            break
    cutoff, huber = math.log(1.25), math.log(1.06)
    items = [(v, w) for v, w in items if abs(v-center) <= cutoff]
    if len(items) < 3:
        raise ValueError("Inconsistent face proportions")
    for _ in range(3):
        robust = [(v, w*min(1., huber/max(1e-12, abs(v-center)))) for v, w in items]
        center = sum(v*w for v, w in robust)/sum(w for _, w in robust)
    if (reference_head > 0 and measured_head > 0 and
            math.isfinite(reference_head) and math.isfinite(measured_head)):
        delta = math.log(reference_head/measured_head)-center
        if abs(delta) <= math.log(1.20):
            center += max(-math.log(1.025), min(math.log(1.025), delta*.12))
    return math.exp(center)


def _portrait_domain(items):
    # Every constraint is linear in common face size q and common eye height e.
    # e >= a*q+b (lower); e <= a*q+b (upper). Pairwise inequalities give
    # an exact feasible q interval, without grids or iterative searches.
    lower, upper = [(0., .05)], [(0., .85)]
    qlo, qhi = .001, float("inf")
    for v in items:
        h, w, H, W, u = v["h"], v["w"], v["H"], v["W"], v["unit"]
        ey, bleed = v["ey"], v["bleed"]
        qlo = max(qlo, (W+2*bleed)*u/(w*H))
        if "head_left" in v:
            left, right = v["head_left"], v["head_right"]
            if right <= left:
                return None
            # An edge already missing in the source cannot be preserved by a
            # transform. Keep its reliable face scale in the portrait batch.
            if left > 0:
                qlo = max(qlo, bleed*u/(H*left))
            if right < w:
                qlo = max(qlo, bleed*u/(H*(w-right)))
            if left > 0 and right < w:
                qhi = min(qhi, W*u/(H*(right-left)))
        lower.append((-(h-ey)/u, 1+bleed/H))
        if v["head_top"] > 0:
            lower.append(((ey-v["head_top"])/u, v["top"]))
        upper.append((ey/u, -bleed/H))
        if v["chin"] < h:
            upper.append((-(v["chin"]-ey)/u, 1-v["bottom"]))
    for a, b in lower:
        for c, d in upper:
            k, rhs = a-c, d-b
            if abs(k) < 1e-12:
                if rhs < -1e-9:
                    return None
            elif k > 0:
                qhi = min(qhi, rhs/k)
            else:
                qlo = max(qlo, rhs/k)
    if qhi < qlo-1e-9 or qhi <= 0:
        return None
    return max(.001, qlo), max(qlo, qhi), lower, upper


def _choose_portrait(domain, q, e):
    lo, hi, lower, upper = domain
    q = max(lo, min(hi, q))
    elo = max(a*q+b for a, b in lower)
    ehi = min(a*q+b for a, b in upper)
    return q, elo if e is None else max(elo, min(ehi, e))


def solve_portrait_layout(payload):
    source = payload.get("items") or []
    if not source:
        return {"solutions": [], "adjusted": False, "unequal": False}
    # Choose a median face as the robust reference; no dependence on layer order.
    candidates = [v for v in source if v["portrait"]["metrics"][4] > 2
        and math.isfinite(v["portrait"]["metrics"][4])]
    if not candidates:
        return {"solutions": [], "rejected": [v["id"] for v in source], "unequal": False, "adjusted": False}
    reference_portrait = sorted(candidates, key=lambda v: (v["portrait"]["metrics"][4], str(v["id"])))[len(candidates)//2]["portrait"]
    reference = reference_portrait["metrics"]
    items, rejected = [], []
    for item in source:
        p, layer, frame = item["portrait"], item["layer"], item["frame"]
        try:
            ratio = facial_ratio(reference, p["metrics"],
                reference_portrait.get("head", 0.), p.get("head", 0.))
            unit = reference[4]/ratio
            v = {"id": item["id"], "w": float(layer["width"]), "h": float(layer["height"]),
                "H": float(frame["height"]), "W": float(frame["width"]),
                "fx": float(frame["left"]), "fy": float(frame["top"]),
                "ex": float(p["eye"][0])-float(layer["left"]),
                "ey": float(p["eye"][1])-float(layer["top"]),
                "head_top": float(p["head_top"])-float(layer["top"]),
                "chin": float(p["chin"])-float(layer["top"]), "unit": unit,
                "top": float(item.get("top", 0))/100., "bottom": .015,
                "bleed": max(0., float(payload.get("bleed", 2)))}
            if not all(math.isfinite(v[k]) and v[k] > 0 for k in ("w", "h", "H", "W", "unit")):
                raise ValueError("Invalid geometry")
            if not (0 < v["ex"] < v["w"] and 0 < v["ey"] < v["h"]):
                raise ValueError("Face outside image")
            if "head_left" in p and "head_right" in p:
                v["head_left"] = float(p["head_left"])-float(layer["left"])
                v["head_right"] = float(p["head_right"])-float(layer["left"])
            items.append(v)
        except (ValueError, KeyError, TypeError, ZeroDivisionError, OverflowError):
            rejected.append(item["id"])
    # An intrinsically impossible/cropped source must not break equality for
    # every other portrait. Exclude it first and keep its ordinary placement.
    feasible = []
    for v in items:
        v["domain"] = _portrait_domain([v])
        if v["domain"] is None:
            rejected.append(v["id"])
        else:
            feasible.append(v)
    items = feasible
    desired_q = max(.08, min(.5, float(payload.get("size", 22))/100.))
    # New UI: position the common eye line as high as all crowns, the separate
    # portrait top margin and source coverage allow. The legacy explicit eye
    # parameter remains supported by the protocol when auto_eye_line is absent.
    desired_e = None if payload.get("auto_eye_line", False) else max(.05, min(.85, float(payload.get("eye_line", 35))/100.))
    if not items:
        return {"solutions": [], "rejected": rejected, "unequal": False, "adjusted": False}
    domain = _portrait_domain(items)
    unequal = domain is None
    if domain:
        q, e = _choose_portrait(domain, desired_q, desired_e)
    else:
        # Eye-height intervals can disagree while all scale intervals overlap.
        # Preserve that common scale before compromising individual eye levels.
        qlo = max(v["domain"][0] for v in items)
        qhi = min(v["domain"][1] for v in items)
        q = max(qlo, min(qhi, desired_q)) if qlo <= qhi else max(qlo, desired_q)
        elo = max(max(a*q+b for a, b in v["domain"][2]) for v in items)
        ehi = min(min(a*q+b for a, b in v["domain"][3]) for v in items)
        e = (elo+ehi)*.5 if desired_e is None else desired_e
    result = []
    for v in items:
        if unequal:
            individual = v["domain"]
            if not individual:
                rejected.append(v["id"])
                continue
            qi, ei = _choose_portrait(individual, q, e)
        else:
            qi, ei = q, e
        scale = qi*v["H"]/v["unit"]
        tx = v["fx"]+v["W"]*.5-scale*v["ex"]
        xlo = v["fx"]+v["W"]+v["bleed"]-scale*v["w"]
        xhi = v["fx"]-v["bleed"]
        if "head_left" in v:
            if v["head_left"] > 0:
                xlo = max(xlo, v["fx"]-scale*v["head_left"])
            if v["head_right"] < v["w"]:
                xhi = min(xhi, v["fx"]+v["W"]-scale*v["head_right"])
        tx = max(xlo, min(xhi, tx))
        ty = v["fy"]+ei*v["H"]-scale*v["ey"]
        result.append({"id": v["id"], "scale": scale, "tx": tx, "ty": ty,
            "eye_line": ei*100., "size": qi*100.})
    return {"solutions": result, "rejected": rejected, "unequal": unequal,
        "adjusted": abs(q-desired_q) > 1e-6 or (desired_e is not None and abs(e-desired_e) > 1e-6),
        "size": q*100., "eye_line": None if e is None else e*100.}


def match_with_portraits(payload):
    assignments = match_items(payload)
    answer = {"assignments": assignments}
    options = payload.get("portrait_options")
    if options is None:
        return answer
    subjects = {str(v["id"]): v for v in payload.get("subjects", [])}
    frames = {str(v["id"]): v for v in payload.get("frames", [])}
    items = []
    for pair in assignments:
        subject = subjects.get(str(pair["subject_id"]))
        frame = frames.get(str(pair["frame_id"]))
        if subject and frame and subject.get("portrait") and not subject.get("bounds_only"):
            items.append({"id": subject["id"], "portrait": subject["portrait"],
                "layer": subject["layer"], "frame": frame, "top": frame.get("portrait_top", 0)})
    answer["portrait_layout"] = solve_portrait_layout(dict(options, items=items))
    return answer


def average_ranks(items, key_func):
    """Normalized [0..1] ranks; equal values get the same average rank."""
    n = len(items)
    if n <= 1:
        return {items[0]["id"]: 0.5} if n == 1 else {}
    decorated = sorted(
        [(key_func(x), i, x["id"]) for i, x in enumerate(items)],
        key=lambda t: (t[0], t[1]),
    )
    out = {}
    i = 0
    while i < n:
        j = i + 1
        while j < n and decorated[j][0] == decorated[i][0]:
            j += 1
        avg_index = (i + j - 1) * 0.5
        rank = avg_index / float(n - 1)
        for k in range(i, j):
            out[decorated[k][2]] = rank
        i = j
    return out


def hungarian(cost):
    """Minimum-cost one-to-one assignment. Returns row -> column or -1."""
    if not cost:
        return []
    n = len(cost)
    m = len(cost[0]) if n else 0
    if m == 0:
        return [-1] * n

    if n > m:
        transposed = [[cost[i][j] for i in range(n)] for j in range(m)]
        trans_assignment = hungarian(transposed)
        assignment = [-1] * n
        for frame_row, subject_col in enumerate(trans_assignment):
            if subject_col >= 0:
                assignment[subject_col] = frame_row
        return assignment

    u = [0.0] * (n + 1)
    v = [0.0] * (m + 1)
    p = [0] * (m + 1)
    way = [0] * (m + 1)
    inf = float("inf")

    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = [inf] * (m + 1)
        used = [False] * (m + 1)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = inf
            j1 = 0
            for j in range(1, m + 1):
                if used[j]:
                    continue
                cur = float(cost[i0 - 1][j - 1]) - u[i0] - v[j]
                if cur < minv[j]:
                    minv[j] = cur
                    way[j] = j0
                if minv[j] < delta:
                    delta = minv[j]
                    j1 = j
            for j in range(0, m + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break

    assignment = [-1] * n
    for j in range(1, m + 1):
        if p[j] != 0:
            assignment[p[j] - 1] = j - 1
    return assignment


def match_group(subjects, frames, use_face_count=True):
    if not subjects or not frames:
        return []

    # The primary cost comes from JSX, which evaluates the exact object-placement
    # geometry for each photo/frame pair. There is intentionally no hard
    # portrait/landscape split: an opposite-orientation frame can win when it
    # gives the better real composition.
    if use_face_count:
        # A subject that fell back to complete layer bounds has no reliable face
        # count/object size. Exclude it from the people-count ranking instead of
        # letting the artificial zero-face value distort the rest of the group.
        ranked_subjects = [x for x in subjects if not bool(x.get("bounds_only", False))]
        # Pixel area depends on source resolution/crop, not on group size.
        # When all counts tie, omit this preference entirely (also with surplus
        # frames), so only the supplied composition costs decide the assignment.
        use_face_count = len(set(int(x.get("faces", 0)) for x in ranked_subjects)) > 1
    s_rank = average_ranks(ranked_subjects, lambda x: int(x.get("faces", 0))) if use_face_count else {}
    f_rank = average_ranks(frames, lambda x: float(x.get("area", 0.0))) if use_face_count else {}

    matrix = []
    for subject in subjects:
        row = []
        placement_costs = subject.get("placement_costs") or {}
        sr = max(1e-6, float(subject.get("ratio", 1.0)))
        for frame in frames:
            raw_cost = placement_costs.get(str(frame.get("id")))
            try:
                placement_cost = float(raw_cost)
                if not math.isfinite(placement_cost) or placement_cost < 0:
                    raise ValueError()
            except (TypeError, ValueError):
                # Compatibility fallback. New JSX always supplies placement_costs.
                fr = max(1e-6, float(frame.get("ratio", 1.0)))
                placement_cost = abs(math.log(sr / fr)) * RATIO_WEIGHT

            size_cost = 0.0
            if use_face_count and not bool(subject.get("bounds_only", False)):
                # Per-layer Layer-bounds fallback is matched only by its supplied
                # geometry cost. Face count/relative group size is unknown here.
                size_cost = abs(s_rank[subject["id"]] - f_rank[frame["id"]]) * SIZE_WEIGHT
            row.append(placement_cost + size_cost)
        matrix.append(row)

    assignment = hungarian(matrix)
    out = []
    for i, j in enumerate(assignment):
        if j >= 0:
            out.append(
                {
                    "subject_id": subjects[i]["id"],
                    "frame_id": frames[j]["id"],
                }
            )
    return out


def match_items(payload):
    subjects = payload.get("subjects") or []
    frames = payload.get("frames") or []
    use_face_count = bool(payload.get("use_face_count", True))
    colors = {}
    for subject in subjects:
        colors.setdefault(str(subject.get("color", "none")), {"subjects": [], "frames": []})[
            "subjects"
        ].append(subject)
    for frame in frames:
        colors.setdefault(str(frame.get("color", "none")), {"subjects": [], "frames": []})[
            "frames"
        ].append(frame)

    result = []
    for group in colors.values():
        result.extend(match_group(group["subjects"], group["frames"], use_face_count))
    return result


def valid_preview_path(path):
    return (isinstance(path,str) and
            os.path.normcase(os.path.realpath(os.path.dirname(path)))==os.path.normcase(os.path.realpath(tempfile.gettempdir())) and
            re.fullmatch(r'align_fit_\d+_\d+_\d+_\d+\.(?:jpg|psb)',os.path.basename(path),re.IGNORECASE))


def safe_remove_preview(path):
    if not valid_preview_path(path):return
    try:os.remove(path)
    except OSError:pass


def send_data_to_jsx(obj):
    data = (json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(10)
            sock.connect((API_HOST, API_PORT_SEND))
            sock.sendall(data)
    except Exception:
        pass


def receive_json(client_socket):
    chunks = []
    total = 0
    while True:
        chunk = client_socket.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > 8 * 1024 * 1024:
            raise RuntimeError("Request is too large")
        if b"\n" in chunk:
            break
    raw = b"".join(chunks)
    if b"\n" in raw:
        raw = raw.split(b"\n", 1)[0]
    if not raw:
        return None
    return json.loads(raw.decode("utf-8"))


def request_started():
    global last_request_time, active_requests
    with activity_lock:
        active_requests += 1
        last_request_time = time.time()


def request_finished():
    global last_request_time, active_requests
    with activity_lock:
        if active_requests > 0:
            active_requests -= 1
        # Idle countdown starts after work for the most recent request is complete.
        last_request_time = time.time()


preview_read_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='fit-preview')
preview_analysis_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='fit-analysis')
preview_batches = {}
preview_batches_lock = threading.Lock()


def map_preview_analysis(info, mapping):
    """Map exported pixels to the original layer's normalized coordinate space."""
    value=deepcopy(info)
    w,h=float(value['width']),float(value['height'])
    span_x,span_y,ox,oy=[float(v) for v in mapping]
    if not all(math.isfinite(v) for v in (w,h,span_x,span_y,ox,oy)) or min(w,h,span_x,span_y)<=0:
        raise ValueError('Invalid preview coordinate mapping')
    sx,sy=span_x/w,span_y/h
    if value.get('bbox'):
        value['bbox']=[v*(sx if i%2==0 else sy)+(ox if i%2==0 else oy) for i,v in enumerate(value['bbox'])]
    if value.get('visual_center_x') is not None:value['visual_center_x']=value['visual_center_x']*sx+ox
    if value.get('bottom_gap_ratio') is not None:
        value['bottom_gap_ratio']=max(0.,1.-((1.-value['bottom_gap_ratio'])*span_y+oy))
    p=value.get('portrait')
    if p:
        metric_scale=math.sqrt(sx*sy)
        p['eye']=[p['eye'][0]*sx+ox,p['eye'][1]*sy+oy]
        p['metrics']=[v*metric_scale for v in p['metrics']]
        p['head']=p.get('head',0)*metric_scale
        for k in ('head_top','chin'):p[k]=p[k]*sy+oy
        for k in ('head_left','head_right'):p[k]=p[k]*sx+ox
    value['width'],value['height']=1.,1.
    return value


def decode_preview_batch(batch,index,path):
    acquired=False
    try:
        with batch['read_order']:
            while index!=batch['next_read']:
                if batch['cancel'].is_set():return None,False
                batch['read_order'].wait(.1)
            while not batch['cancel'].is_set():
                if batch['slots'].acquire(timeout=.1):
                    acquired=True;batch['next_read']+=1;batch['read_order'].notify_all();break
        if not acquired or batch['cancel'].is_set():return None,acquired
        image=read_detector_image(path) if path.lower().endswith('.psb') else read_image(path,np,_load_dependencies()[1])
        if image is None:raise ValueError('Cannot decode prepared image')
        return image,acquired
    except Exception as exc:return exc,acquired
    finally:safe_remove_preview(path)


def analyze_preview_batch(batch,item,decoded):
    acquired=False
    try:
        image,acquired=decoded.result()
        check_analysis_cancelled(batch['cancel'])
        if isinstance(image,Exception):raise image
        info=read_cached_analysis(item.get('cache_key'),batch['portraits'])
        if info is None:
            info=analyze_image(None,portraits=batch['portraits'],cancel_event=batch['cancel'],image=image)
            check_analysis_cancelled(batch['cancel'])
            info=map_preview_analysis(info,item['mapping'])
            info=store_cached_analysis(item.get('cache_key'),info,batch['portraits'])
        info['id']=item['id']
        return info
    except AnalysisCancelled:return {'id':item['id'],'error':'Operation cancelled','bbox':None,'faces':0}
    except Exception as exc:return {'id':item['id'],'error':str(exc),'bbox':None,'faces':0,'visual_center_x':None}
    finally:
        if acquired:batch['slots'].release()


def handle_preview_batch(kind,payload,request_id,reply):
    if not isinstance(payload,dict):raise ValueError('Invalid preview batch payload')
    if kind=='batch_begin':
        with preview_batches_lock:
            if preview_batches:raise RuntimeError('Previous preview batch is still active')
            batch_id=uuid.uuid4().hex
            batch=dict(cancel=threading.Event(),portraits=bool(payload.get('portraits')),jobs=[],finishing=False,
                       slots=threading.Semaphore(3),read_order=threading.Condition(),next_read=0,last=time.time())
            preview_batches[batch_id]=batch
        try:reply('answer',batch_id)
        except Exception:
            batch['cancel'].set()
            with preview_batches_lock:preview_batches.pop(batch_id,None)
            raise
        return
    batch_id=payload.get('batch_id')
    with preview_batches_lock:
        batch=preview_batches.get(batch_id)
        if batch:batch['last']=time.time()
    if batch is None:
        if kind=='batch_abort':reply('answer',True);return
        raise ValueError('Unknown preview batch')
    if kind=='batch_add':
        with preview_batches_lock:
            if batch['finishing'] or batch['cancel'].is_set():raise RuntimeError('Preview batch is closed')
            index,item=payload.get('index'),payload.get('item')
            if type(index) is not int or index!=len(batch['jobs']) or not isinstance(item,dict):raise ValueError('Invalid preview order')
            path=item.get('path');mapping=item.get('mapping')
            if type(item.get('id')) is not int or not valid_preview_path(path):raise ValueError('Invalid preview path/layer')
            if not isinstance(mapping,list) or len(mapping)!=4 or not all(type(v) in (int,float) and math.isfinite(v) for v in mapping) or min(mapping[:2])<=0:
                raise ValueError('Invalid preview mapping')
            decoded=preview_read_pool.submit(decode_preview_batch,batch,index,path)
            batch['jobs'].append(preview_analysis_pool.submit(analyze_preview_batch,batch,item,decoded))
        reply('answer',True)
    elif kind=='batch_abort':
        batch['cancel'].set()
        with preview_batches_lock:preview_batches.pop(batch_id,None)
        reply('answer',True)
    elif kind=='batch_finish':
        with preview_batches_lock:
            if batch['finishing'] or batch['cancel'].is_set():raise RuntimeError('Preview batch is closed')
            batch['finishing']=True
        with activity_lock:analysis_requests[request_id]=batch['cancel']
        try:
            while not all(job.done() for job in batch['jobs']):
                if batch['cancel'].wait(.05):reply('cancelled','Operation cancelled');return
            if batch['cancel'].is_set():reply('cancelled','Operation cancelled');return
            reply('answer',{'items':[job.result() for job in batch['jobs']]})
        finally:
            batch['cancel'].set()
            with activity_lock:analysis_requests.pop(request_id,None)
            with preview_batches_lock:preview_batches.pop(batch_id,None)
    else:raise ValueError('Unknown preview batch command')


def expire_preview_batches():
    with preview_batches_lock:
        for key,batch in list(preview_batches.items()):
            if not batch['finishing'] and time.time()-batch['last']>TIMEOUT:
                batch['cancel'].set();preview_batches.pop(key,None)


def handle_client(client_socket, server):
    started = False
    request_id = None
    cancel_event = None
    try:
        with client_socket:
            client_socket.settimeout(10)
            message = receive_json(client_socket)
            if not message:
                return
            msg_type = message.get("type")
            payload = message.get("message")
            request_id = message.get("request_id")

            # Fire-and-forget: Photoshop has already stopped listening when it
            # cancels. Keep the loaded models, but stop processing this batch.
            if msg_type == "cancel":
                with activity_lock:
                    event = analysis_requests.get((payload or {}).get("request_id"))
                    if event is not None:
                        event.set()
                return

            def reply(reply_type, reply_message):
                out = {"type": reply_type, "message": reply_message}
                if request_id is not None:
                    out["request_id"] = request_id
                send_data_to_jsx(out)

            request_started()
            started = True

            if msg_type == "handshake":
                get_models()
                reply("answer", {"status": "success", "version": SERVER_VERSION, "idle_timeout": TIMEOUT})
            elif msg_type == "analysis_cache":
                options = payload or {}
                entries = options.get("items") or []
                if not isinstance(entries, list) or len(entries) > ANALYSIS_CACHE_LIMIT:
                    raise ValueError("Invalid analysis cache request")
                reply("answer", {"items": [{"id": v["id"], "analysis": read_cached_analysis(
                    v.get("cache_key"), bool(options.get("portraits", False)))} for v in entries]})
            elif isinstance(msg_type,str) and msg_type.startswith('batch_'):
                handle_preview_batch(msg_type,payload,request_id,reply)
            elif msg_type == "portrait_layout":
                reply("answer", solve_portrait_layout(payload or {}))
            elif msg_type == "match":
                reply("answer", match_with_portraits(payload or {}))
            elif msg_type == "exit":
                reply("answer", "bye")
                try:
                    server.close()
                finally:
                    os._exit(0)
            else:
                reply("error", "Unknown request type: %s" % msg_type)
    except Exception as exc:
        detail = str(exc) or exc.__class__.__name__
        out = {"type": "error", "message": detail}
        if request_id is not None:
            out["request_id"] = request_id
        send_data_to_jsx(out)
    finally:
        if cancel_event is not None:
            with activity_lock:
                analysis_requests.pop(request_id, None)
        if started:
            request_finished()


def timeout_watcher():
    while True:
        time.sleep(5)
        expire_preview_batches()
        with activity_lock:
            idle = not preview_batches and active_requests == 0 and (time.time() - last_request_time > TIMEOUT)
        if idle:
            os._exit(0)


def start_server():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((API_HOST, API_PORT_LISTEN))
    server.listen(20)
    threading.Thread(target=timeout_watcher, daemon=True).start()
    while True:
        try:
            client_socket, _addr = server.accept()
            threading.Thread(target=handle_client, args=(client_socket, server), daemon=True).start()
        except OSError:
            break
        except Exception:
            continue


if __name__ == "__main__":
    start_server()
