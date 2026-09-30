import os
import json
import math
import socket
import threading
import time
import sys

API_HOST = "127.0.0.1"
API_PORT_SEND = 6321       # Python -> JSX
API_PORT_LISTEN = 6320     # JSX -> Python
TIMEOUT = 15 * 60
SERVER_VERSION = "0.4.6"

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
activity_lock = threading.Lock()
model_lock = threading.Lock()
model_init_lock = threading.Lock()
_models = None
_model_error = None


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
        image = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        image = cv2.resize(image, (192, 192), interpolation=cv2.INTER_AREA)
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


def analyze_image(path):
    np, cv2, human_segmenter, face_detector = get_models()
    image = read_image(path, np, cv2)
    if image is None:
        raise RuntimeError("Cannot read preview: %s" % path)
    h, w = image.shape[:2]
    with model_lock:
        human_mask = human_segmenter.mask(image)
        face_detections = face_detector.detect(image)

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
        if cx2 - cx1 >= 32 and cy2 - cy1 >= 32:
            crop = image[cy1:cy2, cx1:cx2]
            with model_lock:
                refined_mask = human_segmenter.mask(crop)
            local_faces = []
            for fx1, fy1, fx2, fy2 in face_boxes:
                if fx2 < cx1 or fx1 > cx2 or fy2 < cy1 or fy1 > cy2:
                    continue
                local_faces.append([fx1 - cx1, fy1 - cy1, fx2 - cx1, fy2 - cy1])
            refined, refined_center_x, refined_faces = human_geometry_from_mask(
                refined_mask, np, cv2, local_faces
            )
            if refined is not None:
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

    return {
        "bbox": bbox,
        "faces": len(face_boxes),
        "visual_center_x": visual_x,
        "width": int(w),
        "height": int(h),
    }


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
        s_rank = average_ranks(
            ranked_subjects,
            lambda x: (int(x.get("faces", 0)), float(x.get("bbox_area", 0.0))),
        )
        f_rank = average_ranks(frames, lambda x: float(x.get("area", 0.0)))
    else:
        s_rank = {}
        f_rank = {}

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


def safe_remove_preview(path):
    """Delete only our temporary JPEGs; JSX also performs its own cleanup."""
    try:
        if not path:
            return
        name = os.path.basename(path).lower()
        if not (name.startswith("align_fit_") and name.endswith(".jpg")):
            return
        if os.path.isfile(path):
            os.remove(path)
    except Exception:
        pass


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


def handle_client(client_socket, server):
    started = False
    request_id = None
    try:
        with client_socket:
            client_socket.settimeout(10)
            message = receive_json(client_socket)
            if not message:
                return
            msg_type = message.get("type")
            payload = message.get("message")
            request_id = message.get("request_id")

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
            elif msg_type == "analyze":
                items = (payload or {}).get("items") or []
                result = []
                for item in items:
                    item_id = item.get("id")
                    path = item.get("path", "")
                    try:
                        info = analyze_image(path)
                        info["id"] = item_id
                        result.append(info)
                    except Exception as exc:
                        result.append(
                            {
                                "id": item_id,
                                "error": str(exc),
                                "bbox": None,
                                "faces": 0,
                                "visual_center_x": None,
                            }
                        )
                    finally:
                        safe_remove_preview(path)
                reply("answer", {"items": result})
            elif msg_type == "match":
                result = match_items(payload or {})
                reply("answer", {"assignments": result})
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
        if started:
            request_finished()


def timeout_watcher():
    while True:
        time.sleep(5)
        with activity_lock:
            idle = active_requests == 0 and (time.time() - last_request_time > TIMEOUT)
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
