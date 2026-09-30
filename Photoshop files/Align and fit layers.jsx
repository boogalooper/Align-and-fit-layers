#target photoshop
/*
// BEGIN__HARVEST_EXCEPTION_ZSTRING
<javascriptresource>
<name>Align and fit layers</name>
<category>alignment</category>
<enableinfo>true</enableinfo>
<eventid>5a2946a7-c3d1-430b-8527-c854f5bb7241</eventid>
<terminology><![CDATA[<< /Version 1
    /Events <<
        /5a2946a7-c3d1-430b-8527-c854f5bb7241 [(Align and fit layers) <<
            /inAction [(action settings) /boolean]
        >>]
    >>
>> ]]></terminology>
</javascriptresource>
// END__HARVEST_EXCEPTION_ZSTRING
*/

var SCRIPT_VERSION = '0.5.34',
    UUID = '5a2946a7-c3d1-430b-8527-c854f5bb7241',
    API_HOST = '127.0.0.1',
    API_PORT_SEND = 6320,
    API_PORT_LISTEN = 6321,
    API_FILES = ['lib/align-fit-api.pyw', 'align-fit-api.pyw'],
    RUNTIME_NAME = 'AlignFitRuntime',
    EXPECTED_SERVER_VERSION = '0.4.6',
    PREVIEW_MAX = 1280,
    FINAL_BLEED_PX = 2,
    INIT_DELAY = 15000,
    ANALYZE_DELAY = 120000,
    MATCH_DELAY = 10000,
    PING_DELAY = 500,
    lr = new AM('layer'),
    doc = new AM('document'),
    previousLayer = new AM('layer', 'backwardEnum'),
    apl = new AM('application'),
    str = new Locale(),
    cfg = new Config(),
    capabilities = getCapabilities(),
    runtimeInfo = getRuntimeInfo(),
    apiFile = findApiFile((new File($.fileName)).path),
    afApi = null,
    runCtx = null,
    inAction = true,
    isCancelled = false;

$.localize = true;

// Python is an optional engine. Its availability is established only from files
// already installed on disk; opening the settings dialog never starts a server.
capabilities.python = pythonFilesAvailable(apiFile, runtimeInfo);

try {
    var playbackCount = 0;
    try { playbackCount = app.playbackParameters.count; } catch (e0) { playbackCount = 0; }

    if (!playbackCount || playbackCount == 1) {
        cfg.getScriptSettings(false);
        cfg.resolveEngine();
        var w = dialog(false), result = w.show();
        if (result == 2) {
            isCancelled = true;
        } else {
            cfg.putScriptSettings(true);
            runWithPhotoshopProgress();
        }
        cfg.putScriptSettings(false);
    } else {
        cfg.getScriptSettings(true);
        cfg.resolveEngine();
        if (app.playbackDisplayDialogs == DialogModes.ALL) {
            var wa = dialog(true), resultA = wa.show();
            if (resultA == 2) {
                isCancelled = true;
            } else {
                cfg.putScriptSettings(true);
            }
        }
        if (app.playbackDisplayDialogs != DialogModes.ALL) {
            runWithPhotoshopProgress();
        }
    }
} catch (startupError) {
    if (startupError.number && startupError.number == 8007) {
        isCancelled = true;
    } else {
        alert(startupError, L(str.err));
    }
}

isCancelled ? 'cancel' : undefined;

function L(v) {
    if (typeof v == 'string') return v;
    try {
        var loc = String($.locale || '').toLowerCase();
        if (loc.indexOf('ru') == 0 && v.ru != undefined) return v.ru;
        if (v.en != undefined) return v.en;
        if (v.ru != undefined) return v.ru;
    } catch (e) { }
    return String(v);
}

function runWithPhotoshopProgress() {
    if (!apl.getProperty('numberOfDocuments')) throw new Error(L(str.errDoc));
    // Use Photoshop's native progress UI. The work functions below increment it
    // through app.doProgressTask(), matching the pattern used by Face alignment.
    app.doProgress(L(str.progressTitle), 'runScript();');
}

function runScript() {
    var runError = null;
    try {
        cleanupStaleTempFiles();
        runCtx = createRunContext();

        if (cfg.engine == 'python') {
            app.changeProgressText(L(str.startPython));
            afApi = new analysisApi(API_HOST, API_PORT_SEND, API_PORT_LISTEN, apiFile, runtimeInfo);
            afApi.init();

            // Preview generation is one history step and one Undo, so the source
            // layers/clipping stack return exactly to the pre-analysis state.
            app.doProgressSegmentTask(28, 0, 100, 'preparePythonStage();');
            app.doProgressSegmentTask(4, 28, 100, 'analyzePythonStage();');
            runCtx.subjectSegmentStart = 32;
            runCtx.frameSegmentStart = 44;
            runCtx.matchSegmentStart = 64;
            runCtx.alignSegmentStart = 70;
        } else if (cfg.engine == 'device' || cfg.engine == 'cloud') {
            configurePhotoshopSelectionMode();

            // Measure Select Subject inside the layer's own temporary Smart Object.
            // No JPEG export and no resize are used for Photoshop autoCutout modes.
            app.doProgressSegmentTask(35, 0, 100, 'prepareAutoCutoutStage();');
            runCtx.subjectSegmentStart = 35;
            runCtx.frameSegmentStart = 45;
            runCtx.matchSegmentStart = 65;
            runCtx.alignSegmentStart = 70;
        } else {
            // Layer-bounds mode deliberately skips all object/face detection.
            runCtx.subjectSegmentStart = 0;
            runCtx.frameSegmentStart = 20;
            runCtx.matchSegmentStart = 55;
            runCtx.alignSegmentStart = 65;
        }

        runCtx.sourceDoc.suspendHistory('Align and fit layers', 'mainHistory();');
        app.changeProgressText(L(str.done));
        app.updateProgress(100, 100);
    } catch (e) {
        runError = e;
        // Never leave a partly aligned document after an error or ESC.
        // Restoring history here is safe because no further transforms are run.
        try {
            if (runCtx && runCtx.sourceDoc && runCtx.startHistoryState) {
                app.activeDocument = runCtx.sourceDoc;
                runCtx.sourceDoc.activeHistoryState = runCtx.startHistoryState;
            }
        } catch (historyRestoreError) { }
    } finally {
        try {
            if (runCtx && runCtx.selectionModeChanged && runCtx.originalSelectionMode) {
                doc.setSelectionMode(runCtx.originalSelectionMode);
            }
        } catch (restoreModeError) { }
        try { if (runCtx && runCtx.tempFiles) cleanupTempFiles(runCtx.tempFiles); } catch (cleanupError) { }
        try { if (runCtx && runCtx.sourceDoc) app.activeDocument = runCtx.sourceDoc; } catch (docError) { }
        try { if (runCtx && runCtx.targetIds) reselectLayers(runCtx.targetIds); } catch (selectError) { }
    }
    if (runError) throw runError;
}

function createRunContext() {
    var sourceDoc = activeDocument,
        targetList = doc.getProperty('targetLayersIDs'),
        targetIds = [],
        layerMeta = {},
        tempFiles = [];

    for (var ti = 0; ti < targetList.count; ti++) {
        targetIds.push(targetList.getReference(ti).getIdentifier('layerID'));
    }
    if (!targetIds.length) throw new Error(L(str.errLayers));

    var clippedAtStart = 0;
    for (var mi = 0; mi < targetIds.length; mi++) {
        var mid = targetIds[mi],
            isClipped = !!lr.getProperty('group', false, mid);
        layerMeta[String(mid)] = {
            name: lr.getProperty('name', false, mid),
            color: lr.getProperty('color', false, mid)[1],
            clipped: isClipped,
            clippingBaseId: null
        };
        if (isClipped) clippedAtStart++;
    }

    var allClippedAtStart = targetIds.length > 0 && clippedAtStart == targetIds.length,
        subjectTargetIds = targetIds.slice(0),
        selectedFallback = false,
        fallbackFrameId = null,
        allowUnmatched = false,
        allowedMissingByColor = {},
        plannedFrameColors = {},
        plannedFrames = [];

    if (allClippedAtStart) {
        // Existing clipping structure is authoritative only when every selected
        // layer was clipped at script start.
        for (var ci = 0; ci < targetIds.length; ci++) {
            var cid = targetIds[ci], baseId = findClippingBaseId(cid);
            if (!baseId) throw new Error('Cannot find clipping base for layer: ' + layerMeta[String(cid)].name);
            layerMeta[String(cid)].clippingBaseId = baseId;
        }
        reselectLayers(targetIds);
    } else {
        // Decide normal-vs-fallback BEFORE object detection. This prevents the
        // common-reference layer from being unnecessarily analyzed as a subject.
        var selectedSet = {}, subjectCounts = {}, from = doc.getProperty('hasBackgroundLayer') ? 0 : 1,
            len = doc.getProperty('numberOfLayers');
        for (var si = 0; si < targetIds.length; si++) {
            selectedSet[String(targetIds[si])] = true;
            var sc = String(layerMeta[String(targetIds[si])].color);
            subjectCounts[sc] = (subjectCounts[sc] || 0) + 1;
        }
        for (var li = from; li <= len; li++) {
            if (lr.getProperty('layerSection', false, li, true)[1] == 'layerSectionEnd') continue;
            var lid = lr.getProperty('layerID', false, li, true);
            if (selectedSet[String(lid)]) continue;
            var lc = lr.getProperty('color', false, li, true)[1];
            if (lc == 'none') continue;
            if (!plannedFrameColors[lc]) plannedFrameColors[lc] = [];
            plannedFrameColors[lc].push(lid);
        }

        var matchable = 0, shortage = [], missingTotal = 0;
        for (var color in subjectCounts) {
            var scount = subjectCounts[color],
                fcount = plannedFrameColors[color] ? plannedFrameColors[color].length : 0,
                missing = Math.max(0, scount - fcount);
            matchable += Math.min(scount, fcount);
            if (missing > 0) {
                shortage.push(color + ': ' + fcount + '/' + scount);
                allowedMissingByColor[String(color)] = missing;
                missingTotal += missing;
            }
        }

        if (targetIds.length > 1 && matchable * 2 < targetIds.length) {
            selectedFallback = true;
            fallbackFrameId = getBottomMostSelectedLayerId(targetIds);
            if (!fallbackFrameId) throw new Error(L(str.errFallbackFrame));
            // Fallback uses the bottom selected layer as a new common frame.
            // If that layer is already clipped, its role is ambiguous and the
            // document structure must not be changed implicitly.
            if (layerMeta[String(fallbackFrameId)] && layerMeta[String(fallbackFrameId)].clipped) {
                throw new Error(L(str.errFallbackClipped));
            }
            subjectTargetIds = [];
            for (var fi = 0; fi < targetIds.length; fi++) {
                if (String(targetIds[fi]) != String(fallbackFrameId)) subjectTargetIds.push(targetIds[fi]);
            }
            if (!subjectTargetIds.length) throw new Error(L(str.errLayers));
            plannedFrames = [fallbackFrameId];
        } else {
            // A small shortage is likely a labeling omission. Let the user decide
            // whether to continue; unmatched layers will remain untouched.
            if (shortage.length) {
                if (!showFrameShortageWarning(shortage, missingTotal, targetIds.length)) throw makeUserCancelError();
                allowUnmatched = true;
            }
            for (var pc in subjectCounts) {
                var pf = plannedFrameColors[pc] || [];
                for (var pi = 0; pi < pf.length; pi++) plannedFrames.push(pf[pi]);
            }
        }
    }

    return {
        sourceDoc: sourceDoc,
        startHistoryState: sourceDoc.activeHistoryState,
        targetIds: targetIds,
        subjectTargetIds: subjectTargetIds,
        layerMeta: layerMeta,
        tempFiles: tempFiles,
        items: [],
        analysisMap: {},
        subjects: [],
        frames: [],
        plannedFrames: plannedFrames,
        assignments: null,
        selectedFallback: selectedFallback,
        allowUnmatched: allowUnmatched,
        allowedMissingByColor: allowedMissingByColor,
        allClippedAtStart: allClippedAtStart,
        previewTouched: false,
        previewRestored: false,
        originalSelectionMode: null,
        selectionModeChanged: false
    };
}

function preparePythonStage() {
    var ctx = runCtx,
        oldDialogs = app.displayDialogs;
    try {
        // All Photoshop actions used by preview preparation are silent. Set this
        // once for the batch instead of crossing the DOM bridge for every layer.
        app.displayDialogs = DialogModes.NO;
        ctx.sourceDoc.suspendHistory('Prepare Align and Fit previews', 'preparePythonPreviewsLoop();');
        if (!ctx.items.length || ctx.items.length != ctx.subjectTargetIds.length) {
            throw new Error('Python preview export incomplete: ' + ctx.items.length + ' of ' + ctx.subjectTargetIds.length + ' layers.');
        }
        app.changeProgressText(L(str.restoreLayers));
        undoPreviewHistory(ctx.sourceDoc);
        ctx.previewRestored = true;
        reselectLayers(ctx.targetIds);
    } catch (e) {
        try {
            if (ctx.previewTouched && !ctx.previewRestored) {
                app.activeDocument = ctx.sourceDoc;
                undoPreviewHistory(ctx.sourceDoc);
                ctx.previewRestored = true;
                reselectLayers(ctx.targetIds);
            }
        } catch (restoreError) {
            throw new Error(e.message + '\nAdditionally failed to restore preview history: ' + restoreError.message);
        }
        throw e;
    } finally {
        app.displayDialogs = oldDialogs;
    }
}

function preparePythonPreviewsLoop() {
    var n = runCtx.subjectTargetIds.length,
        slice = 1 / Math.max(1, n);
    for (var i = 0; i < n; i++) {
        app.doProgressTask(slice, 'preparePythonPreviewChunk(' + i + ');');
    }
}

function preparePythonPreviewChunk(i) {
    var id = runCtx.subjectTargetIds[i],
        meta = runCtx.layerMeta[String(id)],
        name = meta ? meta.name : lr.getProperty('name', false, id),
        text = L(str.prepareImages) + ': ' + (i + 1) + '/' + runCtx.subjectTargetIds.length + ' \u2014 ' + name;
    app.activeDocument = runCtx.sourceDoc;
    lr.selectLayer(id);
    if (!lr.getProperty('visible')) lr.setLayerVisiblity(id, true);
    runCtx.previewTouched = true;
    var preview = exportLayerPreview(runCtx.sourceDoc, id, i, runCtx.tempFiles);
    if (preview) runCtx.items.push(preview);
    app.changeProgressText(text);
    $.sleep(0);
}

function analyzePythonStage() {
    app.changeProgressText(L(str.analyzePython));
    // Large selections can legitimately take longer than the fixed base timeout.
    // Keep a generous per-image allowance while capping the wait at 15 minutes.
    var analyzeDelay = Math.max(ANALYZE_DELAY, Math.min(15 * 60 * 1000, runCtx.items.length * 10000)),
        analyzed = afApi.sendPayload('analyze', { items: runCtx.items }, analyzeDelay);
    if (!analyzed || !analyzed.items) throw new Error('Python returned an invalid analysis response.');
    runCtx.analysisMap = {};
    for (var ai = 0; ai < analyzed.items.length; ai++) {
        runCtx.analysisMap[String(analyzed.items[ai].id)] = analyzed.items[ai];
    }
    cleanupTempFiles(runCtx.tempFiles);
    runCtx.tempFiles = [];
}

function prepareAutoCutoutStage() {
    var ctx = runCtx;
    try {
        ctx.sourceDoc.suspendHistory('Measure Align and Fit objects', 'prepareAutoCutoutLoop();');
        if (countOwnProperties(ctx.analysisMap) != ctx.subjectTargetIds.length) {
            throw new Error('Photoshop object measurement incomplete.');
        }
        app.changeProgressText(L(str.restoreLayers));
        undoPreviewHistory(ctx.sourceDoc);
        ctx.previewRestored = true;
        reselectLayers(ctx.targetIds);
    } catch (e) {
        try {
            if (ctx.previewTouched && !ctx.previewRestored) {
                app.activeDocument = ctx.sourceDoc;
                undoPreviewHistory(ctx.sourceDoc);
                ctx.previewRestored = true;
                reselectLayers(ctx.targetIds);
            }
        } catch (restoreError) {
            throw new Error(e.message + '\nAdditionally failed to restore measurement history: ' + restoreError.message);
        }
        throw e;
    }
}

function prepareAutoCutoutLoop() {
    var n = runCtx.subjectTargetIds.length,
        slice = 1 / Math.max(1, n);
    for (var i = 0; i < n; i++) {
        app.doProgressTask(slice, 'prepareAutoCutoutChunk(' + i + ');');
    }
}

function prepareAutoCutoutChunk(i) {
    var id = runCtx.subjectTargetIds[i],
        meta = runCtx.layerMeta[String(id)],
        name = meta ? meta.name : lr.getProperty('name', false, id),
        text = L(str.detectBounds) + ': ' + (i + 1) + '/' + runCtx.subjectTargetIds.length + ' \u2014 ' + name;
    app.activeDocument = runCtx.sourceDoc;
    lr.selectLayer(id);
    if (!lr.getProperty('visible')) lr.setLayerVisiblity(id, true);
    runCtx.previewTouched = true;
    var measured = measureAutoCutoutInSmartObject(runCtx.sourceDoc, id);
    // A layer on which Select Subject found nothing is not fatal. Keep a result
    // entry so collectSubjectChunk() can fall back to this layer's own bounds
    // without changing the engine for the rest of the selection.
    if (!measured) measured = { id: id, bbox: null };
    runCtx.analysisMap[String(id)] = measured;
    app.changeProgressText(text);
    $.sleep(0);
}

function measureAutoCutoutInSmartObject(sourceDoc, id) {
    var smartDoc = null,
        oldDialogs = app.displayDialogs,
        stage = 'select source layer';
    try {
        app.displayDialogs = DialogModes.NO;
        app.activeDocument = sourceDoc;
        lr.selectLayer(id);

        stage = 'convert source layer to Smart Object';
        convertActiveLayerToSmartObject();

        stage = 'open Smart Object contents';
        openActiveSmartObjectContents();
        smartDoc = app.activeDocument;
        if (!smartDoc || smartDoc == sourceDoc) throw new Error('Smart Object contents did not open.');

        // Match the Python preparation path: analyze the visible composite of the
        // selected layer in its own local coordinate system.
        stage = 'flatten Smart Object contents';
        if (Number(doc.getProperty('numberOfLayers')) > 1) doc.flatten();

        var localInfo = doc.getDocumentInfo(),
            localW = localInfo ? Number(localInfo.width) : 0,
            localH = localInfo ? Number(localInfo.height) : 0;
        if (!(localW > 0) || !(localH > 0)) throw new Error('Smart Object has invalid dimensions.');

        stage = 'Select Subject';
        lr.autoCutout();
        var b = null;
        if (doc.hasProperty('selection')) {
            b = doc.descToObject(doc.getProperty('selection'));
            lr.deselect();
            if (!b || !(Number(b.right) > Number(b.left)) || !(Number(b.bottom) > Number(b.top))) b = null;
        }

        var out = {
            id: id,
            width: localW,
            height: localH,
            bbox: b ? [Number(b.left), Number(b.top), Number(b.right), Number(b.bottom)] : null,
            faces: 0
        };

        stage = 'close Smart Object contents';
        doc.close(false);
        smartDoc = null;
        app.activeDocument = sourceDoc;
        return out;
    } catch (e) {
        try {
            if (smartDoc) {
                app.activeDocument = smartDoc;
                doc.close(false);
                smartDoc = null;
            }
        } catch (ignore0) { }
        try { app.activeDocument = sourceDoc; } catch (ignore1) { }
        throw new Error('autoCutout failed for layer ' + id + ' [' + stage + ']: ' + e.message);
    } finally {
        try { app.activeDocument = sourceDoc; } catch (ignore2) { }
        app.displayDialogs = oldDialogs;
    }
}

function countOwnProperties(o) {
    var n = 0;
    for (var k in o) if (o.hasOwnProperty(k)) n++;
    return n;
}

function configurePhotoshopSelectionMode() {
    if (!capabilities.selectionProcessingModes) return;
    try {
        runCtx.originalSelectionMode = doc.getSelectionMode();
        var wanted = cfg.engine == 'cloud' ? 'imageProcessingModeCloud' : 'imageProcessingModeDevice';
        if (runCtx.originalSelectionMode != wanted) {
            doc.setSelectionMode(wanted);
            runCtx.selectionModeChanged = true;
        }
    } catch (e) {
        // Device mode remains valid on versions that support Select Subject but
        // do not expose the Device/Cloud preference through Action Manager.
        if (cfg.engine == 'cloud') throw new Error(L(str.errCloudMode));
    }
}

function mainHistory() {
    var s0 = runCtx.subjectSegmentStart,
        f0 = runCtx.frameSegmentStart,
        m0 = runCtx.matchSegmentStart,
        a0 = runCtx.alignSegmentStart;

    app.doProgressSegmentTask(f0 - s0, s0, 100, 'collectSubjectsStage();');
    prepareFrameList();
    app.doProgressSegmentTask(m0 - f0, f0, 100, 'readFramesStage();');
    app.doProgressSegmentTask(a0 - m0, m0, 100, 'matchFramesStage();');
    app.doProgressSegmentTask(100 - a0, a0, 100, 'alignSubjectsStage();');
}

function collectSubjectsStage() {
    var n = runCtx.subjectTargetIds.length,
        slice = 1 / Math.max(1, n);
    for (var i = 0; i < n; i++) {
        app.doProgressTask(slice, 'collectSubjectChunk(' + i + ');');
    }
    runCtx.subjects.sort(function (a, b) { return a.ratio > b.ratio ? 1 : -1; });
}

function collectSubjectChunk(i) {
    var id = runCtx.subjectTargetIds[i],
        meta = runCtx.layerMeta[String(id)],
        layerName = meta ? meta.name : lr.getProperty('name', false, id),
        text = L(str.detectBounds) + ': ' + (i + 1) + '/' + runCtx.subjectTargetIds.length + ' \u2014 ' + layerName;

    doc.selectLayer(id);
    if (!lr.getProperty('visible')) lr.setLayerVisiblity(id, true);

    var subject = null;
    if (cfg.engine == 'python') {
        var analysis = runCtx.analysisMap[String(id)];
        if (!analysis) throw new Error('Python returned no result for layer: ' + layerName);
        if (!analysis.error && analysis.bbox && analysis.width && analysis.height) {
            subject = subjectFromLocalAnalysis(id, analysis, true);
        }
        // Detection failure is local to this photo. Use complete layer bounds for
        // this one subject, while all other photos keep the selected Python mode.
        if (!subject) {
            subject = subjectFromLayerBounds(id);
            if (!subject) throw new Error(L(str.errLayerBounds) + ': ' + layerName);
        }
    } else if (cfg.engine == 'device' || cfg.engine == 'cloud') {
        var measured = runCtx.analysisMap[String(id)];
        subject = subjectFromLocalAnalysis(id, measured, false);
        // Select Subject returning no usable object is also a per-layer fallback,
        // not a reason to switch or abort the complete batch.
        if (!subject) {
            subject = subjectFromLayerBounds(id);
            if (!subject) throw new Error(L(str.errLayerBounds) + ': ' + layerName);
        }
    } else {
        subject = subjectFromLayerBounds(id);
        if (!subject) throw new Error(L(str.errLayerBounds) + ': ' + layerName);
    }

    subject.color = meta ? meta.color : lr.getProperty('color')[1];
    subject.id = id;
    runCtx.subjects.push(subject);
    app.changeProgressText(text);
    $.sleep(0);
}

function subjectFromLocalAnalysis(id, analysis, fromPython) {
    try {
        if (!analysis || !analysis.bbox || !analysis.width || !analysis.height) return null;

        // Python previews and Photoshop Select Subject are both measured in the
        // temporary Smart Object's local coordinate system. Re-read live restored
        // layer bounds and map that local rectangle back to document coordinates.
        var layerBounds = doc.descToObject(lr.getProperty('boundsNoEffects', false, id));
        if (!layerBounds || !(Number(layerBounds.width) > 0) || !(Number(layerBounds.height) > 0)) return null;
        var sx = Number(layerBounds.width) / Number(analysis.width),
            sy = Number(layerBounds.height) / Number(analysis.height),
            b = analysis.bbox,
            subject = {
                left: Number(layerBounds.left) + Number(b[0]) * sx,
                top: Number(layerBounds.top) + Number(b[1]) * sy,
                right: Number(layerBounds.left) + Number(b[2]) * sx,
                bottom: Number(layerBounds.top) + Number(b[3]) * sy,
                faces: fromPython ? (Number(analysis.faces) || 0) : 0
            };
        if (fromPython && isFiniteNumber(Number(analysis.visual_center_x))) {
            subject.visualCenterX = Number(layerBounds.left) + Number(analysis.visual_center_x) * sx;
        }
        subject.width = subject.right - subject.left;
        subject.height = subject.bottom - subject.top;
        if (!(subject.width > 1) || !(subject.height > 1)) return null;
        subject.center = { y: subject.top + subject.height / 2, x: subject.left + subject.width / 2 };
        subject.ratio = subject.width / subject.height;
        return finishSubjectGeometry(subject, layerBounds);
    } catch (e) {
        return null;
    }
}

function subjectFromLayerBounds(id) {
    var b = doc.descToObject(lr.getProperty('boundsNoEffects', false, id));
    if (!b || !(Number(b.width) > 0) || !(Number(b.height) > 0)) return null;
    var subject = {
        top: Number(b.top), left: Number(b.left), right: Number(b.right), bottom: Number(b.bottom),
        width: Number(b.width), height: Number(b.height), faces: 0
    };
    subject.center = { y: subject.top + subject.height / 2, x: subject.left + subject.width / 2 };
    subject.visualCenterX = subject.center.x;
    subject.ratio = subject.width / subject.height;
    subject.boundsOnly = true;
    // Layer-bounds mode and per-layer detection fallback have no object offsets:
    // the complete layer is the geometry.
    subject.layer = b;
    return subject;
}

function findClippingBaseId(id) {
    // Follow the real clipping chain downward. The first layer that is not
    // clipped is the base layer for this clipping group. Using backwardEnum
    // avoids assumptions about Photoshop itemIndex direction/background offsets.
    var currentId = id, guard = 0;
    try {
        lr.selectLayer(currentId, false);
        while (guard++ < 1000) {
            var belowId = previousLayer.getProperty('layerID');
            if (!belowId || String(belowId) == String(currentId)) return null;
            if (!lr.getProperty('group', false, belowId)) return belowId;
            currentId = belowId;
            lr.selectLayer(currentId, false);
        }
    } catch (e) { }
    return null;
}

function getBottomMostSelectedLayerId(ids) {
    // Photoshop itemIndex grows from the bottom of the layer stack upward
    // (background is 0/1 depending on document structure), so the smallest
    // itemIndex is the bottom-most selected layer.
    var bestId = null, bestIndex = Infinity;
    for (var i = 0; i < ids.length; i++) {
        var idx = Number(lr.getProperty('itemIndex', false, ids[i]));
        if (idx < bestIndex) {
            bestIndex = idx;
            bestId = ids[i];
        }
    }
    return bestId;
}

function prepareFrameList() {
    runCtx.frames = [];

    if (runCtx.allClippedAtStart) {
        var seenBases = {};
        for (var cs = 0; cs < runCtx.subjects.length; cs++) {
            var cm = runCtx.layerMeta[String(runCtx.subjects[cs].id)],
                baseId = cm ? cm.clippingBaseId : null;
            if (!baseId) throw new Error('Cannot find clipping base for layer: ' + (cm ? cm.name : runCtx.subjects[cs].id));
            if (!seenBases[String(baseId)]) {
                seenBases[String(baseId)] = true;
                runCtx.frames.push(baseId);
            }
        }
        return;
    }

    // Normal/fallback choice was already made before object detection.
    for (var i = 0; i < runCtx.plannedFrames.length; i++) runCtx.frames.push(runCtx.plannedFrames[i]);
}

function readFramesStage() {
    var n = runCtx.frames.length,
        slice = 1 / Math.max(1, n);
    if (!n) {
        app.changeProgressText(L(str.readFrames) + ': 0/0');
        return;
    }
    for (var i = 0; i < n; i++) app.doProgressTask(slice, 'readFrameChunk(' + i + ');');
    runCtx.frames.sort(function (a, b) { return a.ratio > b.ratio ? 1 : -1; });
}

function readFrameChunk(i) {
    var id = runCtx.frames[i],
        frameName = lr.getProperty('name', false, id),
        text = L(str.readFrames) + ': ' + (i + 1) + '/' + runCtx.frames.length + ' \u2014 ' + frameName;

    doc.makeSelection(id, lr.getProperty('hasVectorMask', false, id) && !(lr.hasProperty('vectorMaskEmpty', id) ? lr.getProperty('vectorMaskEmpty', false, id) : true));
    doc.setQuickMask(true);
    doc.levels([128, 1, 240]);
    doc.setQuickMask();
    doc.createPath();
    doc.makeSelectionFromPath();
    doc.deleteCurrentPath();
    var frame = doc.descToObject(doc.getProperty('selection'));
    doc.deselect();
    with (frame) {
        frame.height = bottom - top;
        frame.width = right - left;
        frame.center = { y: top + height / 2, x: left + width / 2 };
        frame.vertical = bottom - top > right - left;
        frame.ratio = width / height;
        frame.area = width * height;
    }
    frame.color = lr.getProperty('color', false, id)[1];
    frame.id = lr.getProperty('layerID', false, id);
    runCtx.frames[i] = frame;
    app.changeProgressText(text);
    $.sleep(0);
}

function matchFramesStage() {
    app.changeProgressText(L(str.matchFrames));
    if (runCtx.selectedFallback || runCtx.allClippedAtStart) {
        runCtx.assignments = null;
        return;
    }
    if (cfg.engine == 'python') {
        var matchSubjects = [], matchFrames = [];
        for (var i = 0; i < runCtx.subjects.length; i++) {
            var placementCosts = {};
            for (var pc = 0; pc < runCtx.frames.length; pc++) {
                if (String(runCtx.frames[pc].color) != String(runCtx.subjects[i].color)) continue;
                placementCosts[String(runCtx.frames[pc].id)] = subjectFrameMatchCost(runCtx.subjects[i], runCtx.frames[pc]);
            }
            matchSubjects.push({
                id: runCtx.subjects[i].id,
                color: runCtx.subjects[i].color,
                ratio: runCtx.subjects[i].ratio,
                faces: runCtx.subjects[i].faces ? runCtx.subjects[i].faces : 0,
                bbox_area: runCtx.subjects[i].width * runCtx.subjects[i].height,
                bounds_only: !!runCtx.subjects[i].boundsOnly,
                placement_costs: placementCosts
            });
        }
        for (var j = 0; j < runCtx.frames.length; j++) {
            matchFrames.push({ id: runCtx.frames[j].id, color: runCtx.frames[j].color, ratio: runCtx.frames[j].ratio, area: runCtx.frames[j].area });
        }
        var matched = afApi.sendPayload('match', {
            subjects: matchSubjects,
            frames: matchFrames,
            use_face_count: !!cfg.useFaceCount
        }, MATCH_DELAY);
        if (!matched || !matched.assignments) throw new Error('Python returned an invalid frame-matching response.');
        runCtx.assignments = {};
        for (var mi = 0; mi < matched.assignments.length; mi++) {
            runCtx.assignments[String(matched.assignments[mi].subject_id)] = matched.assignments[mi].frame_id;
        }
    } else if (cfg.engine == 'layer') {
        // Layer-bounds mode has no detected object, so aspect ratio remains the
        // meaningful matching criterion.
        runCtx.assignments = matchByRatio(runCtx.subjects, runCtx.frames);
    } else {
        // Device/Cloud have the same object geometry as the alignment stage, so
        // match frames by the expected result of the real placement algorithm.
        runCtx.assignments = matchByPlacement(runCtx.subjects, runCtx.frames);
    }
    validateAssignments(runCtx.assignments, runCtx.subjects);
}

function validateAssignments(assignments, subjects) {
    var missingByColor = {}, firstUnexpected = null;
    for (var i = 0; i < subjects.length; i++) {
        if (!assignments || assignments[String(subjects[i].id)] == undefined) {
            var color = String(subjects[i].color),
                name = runCtx.layerMeta[String(subjects[i].id)] ? runCtx.layerMeta[String(subjects[i].id)].name : subjects[i].id;
            missingByColor[color] = (missingByColor[color] || 0) + 1;
            if (!firstUnexpected) firstUnexpected = name;
        }
    }
    for (var c in missingByColor) {
        var allowed = runCtx.allowUnmatched ? Number(runCtx.allowedMissingByColor[c] || 0) : 0;
        if (missingByColor[c] > allowed) {
            throw new Error(L(str.errMatching) + ': ' + firstUnexpected);
        }
    }
}

function alignSubjectsStage() {
    var n = runCtx.subjects.length,
        slice = 1 / Math.max(1, n);
    for (var i = 0; i < n; i++) app.doProgressTask(slice, 'alignSubjectChunk(' + i + ');');
}

function alignSubjectChunk(i) {
    var subject = runCtx.subjects[i],
        layerName = lr.getProperty('name', false, subject.id),
        text = L(str.align) + ': ' + (i + 1) + '/' + runCtx.subjects.length + ' \u2014 ' + layerName,
        frame = null;

    if (runCtx.allClippedAtStart) {
        // Preserve the user's existing clipping structure. Each subject uses its
        // own real clipping-base frame; colors and global matching are irrelevant.
        var meta = runCtx.layerMeta[String(subject.id)],
            baseId = meta ? meta.clippingBaseId : null;
        frame = baseId ? findFrameById(runCtx.frames, baseId) : null;
        if (!frame) throw new Error('Cannot read clipping-base frame for layer: ' + layerName);
        lr.selectLayer(subject.id);
        if (usesLayerBoundsPlacement(subject)) alignLayerBounds(subject, frame); else alignLayer(subject, frame);
    } else {
        if (runCtx.selectedFallback) {
            frame = runCtx.frames.length ? runCtx.frames[0] : null;
        } else if (runCtx.assignments && runCtx.assignments[String(subject.id)] != undefined) {
            frame = findFrameById(runCtx.frames, runCtx.assignments[String(subject.id)]);
        }
        // In the user-approved shortage case, an unmatched layer deliberately
        // stays exactly where it was. Fallback is alignment-only: the common
        // bottom layer is a geometric reference, not a clipping base.
        if (frame) {
            if (runCtx.selectedFallback) alignSubjectInPlace(subject, frame);
            else moveAndAlignSubject(subject, frame);
        }
    }
    app.changeProgressText(text);
    $.sleep(0);
}

function usesLayerBoundsPlacement(subject) {
    return cfg.engine == 'layer' || !!(subject && subject.boundsOnly);
}

function alignSubjectInPlace(subject, frame) {
    lr.selectLayer(subject.id);
    if (usesLayerBoundsPlacement(subject)) alignLayerBounds(subject, frame);
    else alignLayer(subject, frame);
}

function moveAndAlignSubject(subject, frame) {
    var offset = doc.getProperty('hasBackgroundLayer') ? 1 : 0,
        subjectIdx = lr.getProperty('itemIndex', false, subject.id) - offset,
        frameIdx = lr.getProperty('itemIndex', false, frame.id) - offset;

    doc.moveLayer(subjectIdx, subjectIdx > frameIdx ? frameIdx + offset : frameIdx - !offset);
    lr.selectLayer(subject.id);

    // Layer-bounds Cover must be computed before clipping changes visible bounds.
    // This applies both to the explicit Layer bounds engine and to an individual
    // photo that fell back because object detection failed.
    if (usesLayerBoundsPlacement(subject)) {
        alignLayerBounds(subject, frame);
        if (!lr.getProperty('group', false, subject.id)) lr.groupCurrentLayer();
    } else {
        if (!lr.getProperty('group', false, subject.id)) lr.groupCurrentLayer();
        alignLayer(subject, frame);
    }
}

function undoPreviewHistory(sourceDoc) {
    app.activeDocument = sourceDoc;
    executeAction(charIDToTypeID('undo'), undefined, DialogModes.NO);
    app.activeDocument = sourceDoc;
}

function layerBoundsMatchCost(subject, frame) {
    var sr = Math.max(1e-6, Number(subject.ratio) || 1),
        fr = Math.max(1e-6, Number(frame.ratio) || 1),
        sv = sr < 1,
        fv = fr < 1;
    return Math.abs(Math.log(sr / fr)) * 12 + (sv != fv ? 4 : 0);
}

function subjectFrameMatchCost(subject, frame) {
    return subject && subject.boundsOnly ? layerBoundsMatchCost(subject, frame) : objectPlacementCost(subject, frame);
}

function matchByCost(subjects, frames, costFn) {
    var groups = {}, result = {};
    for (var i = 0; i < subjects.length; i++) {
        var sc = String(subjects[i].color);
        if (!groups[sc]) groups[sc] = { subjects: [], frames: [] };
        groups[sc].subjects.push(subjects[i]);
    }
    for (var j = 0; j < frames.length; j++) {
        var fc = String(frames[j].color);
        if (!groups[fc]) groups[fc] = { subjects: [], frames: [] };
        groups[fc].frames.push(frames[j]);
    }
    for (var key in groups) {
        var gs = groups[key].subjects, gf = groups[key].frames;
        if (!gs.length || !gf.length) continue;
        var matrix = [];
        for (var si = 0; si < gs.length; si++) {
            var row = [];
            for (var fi = 0; fi < gf.length; fi++) row.push(costFn(gs[si], gf[fi]));
            matrix.push(row);
        }
        var assignment = hungarian(matrix);
        for (var ai = 0; ai < assignment.length; ai++) {
            if (assignment[ai] >= 0) result[String(gs[ai].id)] = gf[assignment[ai]].id;
        }
    }
    return result;
}

function matchByPlacement(subjects, frames) {
    return matchByCost(subjects, frames, subjectFrameMatchCost);
}

function matchByRatio(subjects, frames) {
    return matchByCost(subjects, frames, layerBoundsMatchCost);
}

function hungarian(cost) {
    var n = cost.length;
    if (!n) return [];
    var m = cost[0].length;
    if (!m) { var empty = []; for (var e = 0; e < n; e++) empty.push(-1); return empty; }
    if (n > m) {
        var transposed = [];
        for (var j = 0; j < m; j++) {
            var row = [];
            for (var i = 0; i < n; i++) row.push(cost[i][j]);
            transposed.push(row);
        }
        var ta = hungarian(transposed), out = [];
        for (var oi = 0; oi < n; oi++) out.push(-1);
        for (var r = 0; r < ta.length; r++) if (ta[r] >= 0) out[ta[r]] = r;
        return out;
    }
    var u = [], v = [], p = [], way = [];
    for (var z = 0; z <= n; z++) u.push(0);
    for (var z2 = 0; z2 <= m; z2++) { v.push(0); p.push(0); way.push(0); }
    for (var ii = 1; ii <= n; ii++) {
        p[0] = ii;
        var j0 = 0, minv = [], used = [];
        for (var jj = 0; jj <= m; jj++) { minv.push(Infinity); used.push(false); }
        do {
            used[j0] = true;
            var i0 = p[j0], delta = Infinity, j1 = 0;
            for (var jx = 1; jx <= m; jx++) {
                if (used[jx]) continue;
                var cur = Number(cost[i0 - 1][jx - 1]) - u[i0] - v[jx];
                if (cur < minv[jx]) { minv[jx] = cur; way[jx] = j0; }
                if (minv[jx] < delta) { delta = minv[jx]; j1 = jx; }
            }
            for (var jx2 = 0; jx2 <= m; jx2++) {
                if (used[jx2]) { u[p[jx2]] += delta; v[jx2] -= delta; }
                else minv[jx2] -= delta;
            }
            j0 = j1;
        } while (p[j0] != 0);
        do {
            var jprev = way[j0];
            p[j0] = p[jprev];
            j0 = jprev;
        } while (j0 != 0);
    }
    var assignment = [];
    for (var a = 0; a < n; a++) assignment.push(-1);
    for (var jm = 1; jm <= m; jm++) if (p[jm] != 0) assignment[p[jm] - 1] = jm - 1;
    return assignment;
}

function getCapabilities() {
    var v = parsePhotoshopVersion(app.version),
        hasAuto = versionAtLeast(v, 19, 1),
        hasCloud = versionAtLeast(v, 23, 5);
    return {
        python: false,
        autoCutout: hasAuto,
        cloud: hasAuto && hasCloud,
        selectionProcessingModes: hasCloud
    };
}

function parsePhotoshopVersion(s) {
    var m = String(s).match(/^(\d+)(?:\.(\d+))?/);
    return m ? { major: Number(m[1]), minor: Number(m[2] || 0) } : { major: 0, minor: 0 };
}

function versionAtLeast(v, major, minor) {
    return v.major > major || (v.major == major && v.minor >= minor);
}

function pythonFilesAvailable(api, runtime) {
    try {
        return !!(api && api.exists && runtime &&
            runtime.pythonw && runtime.pythonw.exists &&
            runtime.launcher && runtime.launcher.exists &&
            runtime.humanModel && runtime.humanModel.exists && runtime.humanModel.length >= 5000000 &&
            runtime.faceModel && runtime.faceModel.exists && runtime.faceModel.length >= 200000);
    } catch (e) {
        return false;
    }
}

function availableEngines() {
    var a = [];
    if (capabilities.python) a.push('python');
    if (capabilities.autoCutout) a.push('device');
    if (capabilities.cloud) a.push('cloud');
    a.push('layer');
    return a;
}

function engineIsAvailable(key) {
    var a = availableEngines();
    for (var i = 0; i < a.length; i++) if (a[i] == key) return true;
    return false;
}

function bestDefaultEngine() {
    if (capabilities.python) return 'python';
    if (capabilities.autoCutout) return 'device';
    return 'layer';
}

function engineLabel(key) {
    if (key == 'python') return L(str.enginePython);
    if (key == 'device') return L(str.engineDevice);
    if (key == 'cloud') return L(str.engineCloud);
    return L(str.engineLayer);
}

function engineDescription(key) {
    if (key == 'python') return L(str.descPython);
    if (key == 'device') return L(str.descDevice);
    if (key == 'cloud') return L(str.descCloud);
    return L(str.descLayer);
}

function makeUserCancelError() {
    var e = new Error('User cancelled');
    e.number = 8007;
    return e;
}

function showFrameShortageWarning(shortage, missingTotal, totalLayers) {
    var dlg = new Window("dialog{orientation:'column',alignChildren:['fill','top'],spacing:10,margins:16}"),
        msg = dlg.add("statictext{properties:{multiline:true},preferredSize:[430,125]}"),
        details = dlg.add("statictext{properties:{multiline:true},preferredSize:[430,70]}"),
        buttons = dlg.add("group{orientation:'row',alignment:['center','top'],spacing:10}");
    buttons.add('button', undefined, L(str.continueButton), { name: 'ok' });
    buttons.add('button', undefined, L(str.stopButton), { name: 'cancel' });
    dlg.text = L(str.warningTitle);
    msg.text = L(str.warnFrameCount).replace('%MISSING%', missingTotal).replace('%TOTAL%', totalLayers);
    details.text = L(str.warnFrameDetails) + '\n' + shortage.join(', ');
    return dlg.show() == 1;
}

function dialog(actionMode) {
    var dlg = new Window("dialog{orientation:'column',alignChildren:['fill','top'],spacing:10,margins:16}"),
        pnEngine = dlg.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:8,margins:10}"),
        dlEngine = pnEngine.add('dropdownlist'),
        chFaceCount = pnEngine.add('checkbox'),
        stDesc = pnEngine.add("statictext{properties:{multiline:true},preferredSize:[390,72]}"),
        pnMargins = dlg.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:6,margins:[10,18,10,10]}"),
        stVertical = pnMargins.add('statictext'),
        rowVT = addSliderRow(pnMargins, L(str.topOffset), 0, 20, cfg.vTop),
        rowVB = addSliderRow(pnMargins, L(str.bottomOffset), 0, 20, cfg.vBottom),
        rowVS = addSliderRow(pnMargins, L(str.sideOffset), 0, 20, cfg.vSide),
        stHorizontal = pnMargins.add('statictext'),
        rowHT = addSliderRow(pnMargins, L(str.topOffset), 0, 20, cfg.hTop),
        rowHB = addSliderRow(pnMargins, L(str.bottomOffset), 0, 20, cfg.hBottom),
        rowHS = addSliderRow(pnMargins, L(str.sideOffset), 0, 20, cfg.hSide),
        buttons = dlg.add("group{orientation:'row',alignment:['center','top'],spacing:10}"),
        ok = buttons.add('button', undefined, actionMode ? L(str.save) : L(str.okButton), { name: 'ok' }),
        cancel = buttons.add('button', undefined, L(str.cancel), { name: 'cancel' });

    dlg.text = L(str.title) + ' ' + SCRIPT_VERSION;
    pnEngine.text = L(str.enginePanel);
    chFaceCount.text = L(str.useFaceCount);
    chFaceCount.value = !!cfg.useFaceCount;
    pnMargins.text = L(str.offsetPanel);
    stVertical.text = L(str.verticalFrame);
    stHorizontal.text = L(str.horizontalFrame);

    var engines = availableEngines();
    for (var i = 0; i < engines.length; i++) {
        var item = dlEngine.add('item', engineLabel(engines[i]));
        item.engineKey = engines[i];
    }

    function selectEngine(key) {
        for (var i = 0; i < dlEngine.items.length; i++) {
            if (dlEngine.items[i].engineKey == key) { dlEngine.selection = i; return; }
        }
        dlEngine.selection = 0;
    }
    function updateEngineUI() {
        var key = dlEngine.selection ? dlEngine.selection.engineKey : cfg.engine,
            pythonMode = key == 'python';
        chFaceCount.visible = pythonMode;
        chFaceCount.enabled = pythonMode;
        stDesc.text = engineDescription(key);
        pnMargins.enabled = key != 'layer';
        pnEngine.layout.layout(true);
        dlg.layout.layout(true);
    }

    selectEngine(cfg.engine);
    updateEngineUI();

    dlEngine.onChange = function () {
        if (!this.selection) return;
        cfg.engine = this.selection.engineKey;
        updateEngineUI();
    };
    chFaceCount.onClick = function () {
        cfg.useFaceCount = !!this.value;
    };

    bindSlider(rowVT, function (v) { cfg.vTop = v; });
    bindSlider(rowVB, function (v) { cfg.vBottom = v; });
    bindSlider(rowVS, function (v) { cfg.vSide = v; });
    bindSlider(rowHT, function (v) { cfg.hTop = v; });
    bindSlider(rowHB, function (v) { cfg.hBottom = v; });
    bindSlider(rowHS, function (v) { cfg.hSide = v; });

    dlg.onShow = function () {
        ok.enabled = actionMode ? true : !!apl.getProperty('numberOfDocuments');
    };
    return dlg;
}

function addSliderRow(parent, label, minv, maxv, value) {
    var row = parent.add("group{orientation:'column',alignChildren:['fill','center'],spacing:1,margins:0}"),
        title = row.add("group{orientation:'row',alignChildren:['fill','center'],spacing:5,margins:0}"),
        st = title.add('statictext'),
        val = title.add("statictext{preferredSize:[55,-1],justify:'right'}"),
        sl = row.add('slider', undefined, value, minv, maxv);
    st.text = label;
    sl.preferredSize = [390, -1];
    val.text = formatPercent(value);
    row.slider = sl;
    row.valueText = val;
    return row;
}

function bindSlider(row, setter) {
    row.slider.onChanging = function () {
        var v = Math.round(this.value * 2) / 2;
        row.valueText.text = formatPercent(v);
        setter(v);
    };
    row.slider.onChange = row.slider.onChanging;
}

function formatPercent(v) {
    return (Math.round(Number(v) * 10) / 10) + '%';
}

function Config() {
    var settingsObj = this;
    this.engine = '';
    this.useFaceCount = true;
    // Defaults exactly reproduce the original hard-coded margins.
    this.vTop = 5;
    this.vBottom = 10;
    this.vSide = 5;
    this.hTop = 10;
    this.hBottom = 5;
    this.hSide = 10;

    this.resolveEngine = function () {
        if (!engineIsAvailable(this.engine)) this.engine = bestDefaultEngine();
    };

    // Same playbackParameters scheme as Face alignment.jsx:
    // persistent defaults come from Custom Options, Action playback comes from
    // Photoshop's playbackParameters descriptor.
    this.getScriptSettings = function (fromAction) {
        var d;
        if (fromAction) {
            try { d = playbackParameters; } catch (e0) { d = undefined; }
        } else {
            try { d = getCustomOptions(UUID); } catch (e1) { d = undefined; }
        }
        if (d != undefined) descriptorToObject(settingsObj, d);
        this.resolveEngine();

        function descriptorToObject(o, desc) {
            var l = desc.count;
            for (var i = 0; i < l; i++) {
                var k = desc.getKey(i),
                    t = desc.getType(k),
                    key = app.typeIDToStringID(k);
                // Photoshop may add the terminology marker to playbackParameters.
                // As in Face alignment.jsx, it is not part of Config itself.
                if (!(key in o)) continue;
                switch (t) {
                    case DescValueType.BOOLEANTYPE: o[key] = desc.getBoolean(k); break;
                    case DescValueType.STRINGTYPE: o[key] = desc.getString(k); break;
                    case DescValueType.DOUBLETYPE: o[key] = desc.getDouble(k); break;
                    case DescValueType.INTEGERTYPE: o[key] = desc.getInteger(k); break;
                }
            }
        }
    };

    this.putScriptSettings = function (toAction) {
        var d = objectToDescriptor(settingsObj);
        if (toAction) playbackParameters = d;
        else putCustomOptions(UUID, d, true);

        function objectToDescriptor(o) {
            var desc = new ActionDescriptor(),
                keys = ['engine', 'useFaceCount', 'vTop', 'vBottom', 'vSide', 'hTop', 'hBottom', 'hSide'];

            for (var i = 0; i < keys.length; i++) {
                var key = keys[i], id = app.stringIDToTypeID(key), value = o[key];
                switch (typeof value) {
                    case 'boolean': desc.putBoolean(id, value); break;
                    case 'string': desc.putString(id, value); break;
                    case 'number': desc.putDouble(id, value); break;
                }
            }
            return desc;
        }
    };
}
function Locale() {
    this.title = { ru: '\u0412\u044B\u0440\u0430\u0432\u043D\u0438\u0432\u0430\u043D\u0438\u0435 \u0438 \u0432\u043F\u0438\u0441\u044B\u0432\u0430\u043D\u0438\u0435', en: 'Align and fit layers' };
    this.err = { ru: '\u0421\u043A\u0440\u0438\u043F\u0442 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D', en: 'Script stopped' };
    this.errDoc = { ru: '\u041D\u0435\u0442 \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0433\u043E \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0430!', en: 'No active document!' };
    this.errLayers = { ru: '\u041D\u0435 \u0432\u044B\u0431\u0440\u0430\u043D\u044B \u0441\u043B\u043E\u0438 \u0434\u043B\u044F \u0432\u044B\u0440\u0430\u0432\u043D\u0438\u0432\u0430\u043D\u0438\u044F.', en: 'No layers are selected for alignment.' };
    this.errLayerBounds = { ru: '\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u0433\u0440\u0430\u043D\u0438\u0446\u044B \u0441\u043B\u043E\u044F', en: 'Cannot read layer bounds' };
    this.errCloudMode = { ru: '\u041E\u0431\u043B\u0430\u0447\u043D\u044B\u0439 Select Subject \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u0432 \u044D\u0442\u043E\u0439 \u0432\u0435\u0440\u0441\u0438\u0438 Photoshop.', en: 'Cloud Select Subject is not available in this Photoshop version.' };
    this.errFallbackFrame = { ru: '\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C \u043D\u0438\u0436\u043D\u0438\u0439 \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u0439 \u0441\u043B\u043E\u0439 \u0434\u043B\u044F fallback.', en: 'Cannot determine the bottom-most selected layer for fallback.' };
    this.errFallbackClipped = { ru: '\u041D\u0435\u043B\u044C\u0437\u044F \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u044C fallback: \u0441\u0430\u043C\u044B\u0439 \u043D\u0438\u0436\u043D\u0438\u0439 \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u0439 \u0441\u043B\u043E\u0439 \u0443\u0436\u0435 \u043D\u0430\u0445\u043E\u0434\u0438\u0442\u0441\u044F \u0432 clipping. \u0420\u0430\u0431\u043E\u0442\u0430 \u0441\u043A\u0440\u0438\u043F\u0442\u0430 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430.', en: 'Fallback cannot be used because the bottom-most selected layer is already clipped. The script has been stopped.' };
    this.errMatching = { ru: '\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u0434\u043E\u0431\u0440\u0430\u0442\u044C \u0440\u0430\u043C\u043A\u0443 \u0434\u043B\u044F \u0441\u043B\u043E\u044F', en: 'Could not assign a frame to layer' };
    this.warningTitle = { ru: '\u041D\u0435\u0445\u0432\u0430\u0442\u043A\u0430 \u0440\u0430\u043C\u043E\u043A', en: 'Missing frames' };
    this.warnFrameCount = { ru: '\u041D\u0435 \u0445\u0432\u0430\u0442\u0430\u0435\u0442 \u0440\u0430\u043C\u043E\u043A \u0441 \u0441\u043E\u043E\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0443\u044E\u0449\u0438\u043C\u0438 \u0446\u0432\u0435\u0442\u043E\u0432\u044B\u043C\u0438 \u043C\u0435\u0442\u043A\u0430\u043C\u0438: %MISSING% \u0438\u0437 %TOTAL%.\n\n\u0415\u0441\u043B\u0438 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C, \u0441\u043A\u0440\u0438\u043F\u0442 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u0441\u043B\u043E\u0438, \u0434\u043B\u044F \u043A\u043E\u0442\u043E\u0440\u044B\u0445 \u0435\u0441\u0442\u044C \u0440\u0430\u043C\u043A\u0438. \u041E\u0441\u0442\u0430\u043B\u044C\u043D\u044B\u0435 \u0441\u043B\u043E\u0438 \u043E\u0441\u0442\u0430\u043D\u0443\u0442\u0441\u044F \u043D\u0430 \u0438\u0441\u0445\u043E\u0434\u043D\u044B\u0445 \u043F\u043E\u0437\u0438\u0446\u0438\u044F\u0445.', en: 'There are not enough frames with matching color labels: %MISSING% of %TOTAL%.\n\nIf you continue, the script will process layers that have matching frames. The remaining layers will stay in their original positions.' };
    this.warnFrameDetails = { ru: '\u041F\u043E \u0446\u0432\u0435\u0442\u043E\u0432\u044B\u043C \u043C\u0435\u0442\u043A\u0430\u043C:', en: 'By color label:' };
    this.continueButton = { ru: '\u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C', en: 'Continue' };
    this.stopButton = { ru: '\u041E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C', en: 'Stop' };
    this.progressTitle = { ru: '\u0412\u044B\u0440\u0430\u0432\u043D\u0438\u0432\u0430\u043D\u0438\u0435 \u0438 \u0432\u043F\u0438\u0441\u044B\u0432\u0430\u043D\u0438\u0435', en: 'Align and fit layers' };
    this.startPython = { ru: '\u0417\u0430\u043F\u0443\u0441\u043A Python...', en: 'Starting Python...' };
    this.prepareImages = { ru: '\u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0430 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0439', en: 'Prepare images' };
    this.restoreLayers = { ru: '\u0412\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0435 \u0441\u043B\u043E\u0451\u0432...', en: 'Restore layers...' };
    this.analyzePython = { ru: '\u0410\u043D\u0430\u043B\u0438\u0437 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0439 Python...', en: 'Analyze images in Python...' };
    this.detectBounds = { ru: '\u0413\u0440\u0430\u043D\u0438\u0446\u044B \u043E\u0431\u044A\u0435\u043A\u0442\u0430', en: 'Object bounds' };
    this.readFrames = { ru: '\u0427\u0442\u0435\u043D\u0438\u0435 \u0440\u0430\u043C\u043E\u043A', en: 'Read frames' };
    this.matchFrames = { ru: '\u0421\u043E\u0433\u043B\u0430\u0441\u043E\u0432\u0430\u043D\u0438\u0435 \u0440\u0430\u043C\u043E\u043A...', en: 'Match frames...' };
    this.align = { ru: '\u0412\u044B\u0440\u0430\u0432\u043D\u0438\u0432\u0430\u043D\u0438\u0435', en: 'Align' };
    this.done = { ru: '\u0413\u043E\u0442\u043E\u0432\u043E', en: 'Done' };
    this.enginePanel = { ru: '\u041E\u043F\u0440\u0435\u0434\u0435\u043B\u0435\u043D\u0438\u0435 \u0433\u0440\u0430\u043D\u0438\u0446 \u043E\u0431\u044A\u0435\u043A\u0442\u0430', en: 'Object bounds engine' };
    this.offsetPanel = { ru: '\u041E\u0442\u0441\u0442\u0443\u043F\u044B \u043E\u0431\u044A\u0435\u043A\u0442\u0430 \u043E\u0442 \u0440\u0430\u043C\u043A\u0438, %', en: 'Object margins inside frame, %' };
    this.verticalFrame = { ru: '\u0412\u0435\u0440\u0442\u0438\u043A\u0430\u043B\u044C\u043D\u0430\u044F \u0440\u0430\u043C\u043A\u0430', en: 'Vertical frame' };
    this.horizontalFrame = { ru: '\u0413\u043E\u0440\u0438\u0437\u043E\u043D\u0442\u0430\u043B\u044C\u043D\u0430\u044F \u0440\u0430\u043C\u043A\u0430', en: 'Horizontal frame' };
    this.topOffset = { ru: '\u0421\u0432\u0435\u0440\u0445\u0443', en: 'Top' };
    this.bottomOffset = { ru: '\u0421\u043D\u0438\u0437\u0443', en: 'Bottom' };
    this.sideOffset = { ru: '\u041F\u043E \u0431\u043E\u043A\u0430\u043C', en: 'Sides' };
    this.okButton = { ru: '\u0412\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u044C', en: 'Run' };
    this.save = { ru: '\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438', en: 'Save settings' };
    this.cancel = { ru: '\u041E\u0442\u043C\u0435\u043D\u0430', en: 'Cancel' };
    this.useFaceCount = { ru: '\u0423\u0447\u0438\u0442\u044B\u0432\u0430\u0442\u044C \u043A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E \u043B\u0438\u0446 \u043F\u0440\u0438 \u043F\u043E\u0434\u0431\u043E\u0440\u0435 \u0440\u0430\u043C\u043E\u043A', en: 'Use face count when matching frames' };
    this.enginePython = { ru: 'Python', en: 'Python' };
    this.engineDevice = { ru: 'autoCutout \u2014 on device', en: 'autoCutout \u2014 on device' };
    this.engineCloud = { ru: 'autoCutout \u2014 in cloud', en: 'autoCutout \u2014 in cloud' };
    this.engineLayer = { ru: '\u0413\u0440\u0430\u043D\u0438\u0446\u044B \u0441\u043B\u043E\u044F', en: 'Layer bounds' };
    this.descPython = {
        ru: '\u0411\u044B\u0441\u0442\u0440\u044B\u0439 \u0430\u043D\u0430\u043B\u0438\u0437 \u0443\u043C\u0435\u043D\u044C\u0448\u0435\u043D\u043D\u044B\u0445 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0439 \u0432\u043D\u0435\u0448\u043D\u0438\u043C \u043C\u043E\u0434\u0443\u043B\u0435\u043C. \u041E\u043F\u0440\u0435\u0434\u0435\u043B\u044F\u0435\u0442 \u0433\u0440\u0430\u043D\u0438\u0446\u044B \u0433\u0440\u0443\u043F\u043F\u044B \u0438 \u043F\u0440\u0438\u043C\u0435\u0440\u043D\u043E\u0435 \u0447\u0438\u0441\u043B\u043E \u043B\u0438\u0446. \u041F\u0440\u0438 \u0432\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u043E\u0439 \u043E\u043F\u0446\u0438\u0438 \u0447\u0438\u0441\u043B\u043E \u043B\u0438\u0446 \u0443\u0447\u0438\u0442\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u043F\u0440\u0438 \u043F\u043E\u0434\u0431\u043E\u0440\u0435 \u0440\u0430\u043C\u043E\u043A.',
        en: 'Fast external analysis of reduced previews. Detects the group bounds and an approximate face count. When enabled, face count is also used when matching photos to frames.'
    };
    this.descDevice = {
        ru: 'Photoshop Select Subject: \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0430 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u043E \u043D\u0430 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0435. \u0411\u044B\u0441\u0442\u0440\u0435\u0435 Cloud, \u043D\u043E \u043E\u0431\u044B\u0447\u043D\u043E \u043C\u0435\u043D\u0435\u0435 \u0442\u043E\u0447\u043D\u043E \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u044F\u0435\u0442 \u0433\u0440\u0430\u043D\u0438\u0446\u044B \u043E\u0431\u044A\u0435\u043A\u0442\u0430. \u0427\u0438\u0441\u043B\u043E \u043B\u0438\u0446 \u043D\u0435 \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u044F\u0435\u0442\u0441\u044F.',
        en: 'Photoshop Select Subject processed locally on the device. Faster than Cloud, but usually less accurate at determining object bounds. Face count is not detected.'
    };
    this.descCloud = {
        ru: 'Photoshop Select Subject: \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0430 \u0432 \u043E\u0431\u043B\u0430\u043A\u0435. \u041C\u0435\u0434\u043B\u0435\u043D\u043D\u0435\u0435 Device, \u043D\u043E \u043E\u0431\u044B\u0447\u043D\u043E \u0442\u043E\u0447\u043D\u0435\u0435 \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u044F\u0435\u0442 \u0433\u0440\u0430\u043D\u0438\u0446\u044B \u043E\u0431\u044A\u0435\u043A\u0442\u0430. \u0427\u0438\u0441\u043B\u043E \u043B\u0438\u0446 \u043D\u0435 \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u044F\u0435\u0442\u0441\u044F; \u0442\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F \u0438\u043D\u0442\u0435\u0440\u043D\u0435\u0442.',
        en: 'Photoshop Select Subject processed in the cloud. Slower than Device, but usually more accurate at determining object bounds. Face count is not detected; internet access is required.'
    };
    this.descLayer = {
        ru: '\u0411\u0435\u0437 \u0434\u0435\u0442\u0435\u043A\u0446\u0438\u0438 \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u0432 \u0438 \u043B\u0438\u0446. \u0421\u043B\u043E\u0438 \u0438 \u0440\u0430\u043C\u043A\u0438 \u0441\u043E\u0433\u043B\u0430\u0441\u0443\u044E\u0442\u0441\u044F \u043F\u043E \u043F\u0440\u043E\u043F\u043E\u0440\u0446\u0438\u044F\u043C; \u0437\u0430\u0442\u0435\u043C \u0432\u0435\u0441\u044C \u0441\u043B\u043E\u0439 \u0446\u0435\u043D\u0442\u0440\u0438\u0440\u0443\u0435\u0442\u0441\u044F \u0438 \u043C\u0430\u0441\u0448\u0442\u0430\u0431\u0438\u0440\u0443\u0435\u0442\u0441\u044F \u0442\u0430\u043A, \u0447\u0442\u043E\u0431\u044B \u0433\u0430\u0440\u0430\u043D\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u043E \u043F\u0435\u0440\u0435\u043A\u0440\u044B\u0442\u044C \u0440\u0430\u043C\u043A\u0443. \u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u043E\u0442\u0441\u0442\u0443\u043F\u043E\u0432 \u043D\u0435 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u044E\u0442\u0441\u044F.',
        en: 'No object or face detection. Layers and frames are matched by aspect ratio; the complete layer is then centered and scaled to fully cover the frame. Object margin settings are not used.'
    };
}

function finishSubjectGeometry(subject, layerBounds) {
    try {
        subject.layer = layerBounds;

        // Both Python and autoCutout operate on a rasterized local view. Clamp
        // tiny detection overshoots to the actual restored layer bounds.
        if (subject.top < layerBounds.top) subject.top = layerBounds.top;
        if (subject.left < layerBounds.left) subject.left = layerBounds.left;
        if (subject.bottom > layerBounds.bottom) subject.bottom = layerBounds.bottom;
        if (subject.right > layerBounds.right) subject.right = layerBounds.right;
        subject.width = subject.right - subject.left;
        subject.height = subject.bottom - subject.top;
        if (subject.width <= 1 || subject.height <= 1) return null;
        subject.center = { y: subject.top + subject.height / 2, x: subject.left + subject.width / 2 };
        if (!isFiniteNumber(Number(subject.visualCenterX))) subject.visualCenterX = subject.center.x;
        if (subject.visualCenterX < subject.left) subject.visualCenterX = subject.left;
        if (subject.visualCenterX > subject.right) subject.visualCenterX = subject.right;
        subject.ratio = subject.width / subject.height;
        return subject;
    } catch (e) {
        return null;
    }
}

function exportLayerPreview(sourceDoc, id, index, tempFiles) {
    var smartDoc = null,
        file = null,
        stage = 'prepare source layer';
    try {
        // preparePythonPreviewChunk() already made sourceDoc active and selected id.
        // Avoid repeating a document switch and layer selection for every preview.
        var stamp = (new Date()).getTime(),
            token = Math.floor(Math.random() * 1000000);

        // Work on the ORIGINAL layer. Do not Undo here: all preview-related
        // conversions are restored together after the complete preview pass.
        // Rasterizing an existing Smart Object first avoids creating a nested
        // Smart Object whose contents Photoshop must repeatedly render while
        // resizing/exporting the temporary preview. The source state is restored
        // by the single history rollback after the whole preview pass.
        if (lr.hasProperty('smartObject')) {
            stage = 'rasterize existing Smart Object for preview';
            lr.rasterize();
        }

        stage = 'convert source layer to Smart Object';
        convertActiveLayerToSmartObject();

        stage = 'open Smart Object contents';
        openActiveSmartObjectContents();
        smartDoc = app.activeDocument;
        if (!smartDoc || smartDoc == sourceDoc) throw new Error('Smart Object contents did not open.');

        // Flatten even a one-layer temporary Smart Object. In the common case
        // that layer is itself a placed/rasterized object; flattening it before
        // imageSize/save avoids extra Smart Object rendering during export.
        stage = 'flatten Smart Object contents';
        doc.flatten();

        // Read the temporary document descriptor once instead of crossing the
        // slower DOM bridge for mode, bit depth and dimensions independently.
        stage = 'read preview properties';
        var previewInfo = doc.getDocumentInfo();
        if (!previewInfo || !(previewInfo.width > 0) || !(previewInfo.height > 0)) {
            throw new Error('Smart Object has invalid dimensions.');
        }

        stage = 'convert preview to RGB/8-bit';
        if (previewInfo.mode && previewInfo.mode != 'RGBColor' && previewInfo.mode != 'RGBColorMode') {
            doc.convertToRGB();
        } else if (!previewInfo.mode) {
            // Very old/atypical Photoshop descriptors may omit the mode. Keep a
            // compatibility fallback; it is not used on normal current versions.
            try { if (smartDoc.mode != DocumentMode.RGB) doc.convertToRGB(); } catch (modeError) { }
        }
        if (previewInfo.depth && previewInfo.depth != 8) {
            doc.convertTo8Bit();
        } else if (!previewInfo.depth) {
            try { if (smartDoc.bitsPerChannel != BitsPerChannelType.EIGHT) smartDoc.bitsPerChannel = BitsPerChannelType.EIGHT; } catch (bitsError) { }
        }

        stage = 'resize preview';
        var tw = Number(previewInfo.width),
            th = Number(previewInfo.height),
            maxSide = Math.max(tw, th);
        if (maxSide > PREVIEW_MAX) {
            var k = PREVIEW_MAX / maxSide;
            doc.setScale(k);
        }

        stage = 'save JPEG preview';
        file = new File(Folder.temp.fsName + '/align_fit_' + stamp + '_' + id + '_' + index + '_' + token + '.jpg');
        doc.saveJpegCopy(file, 6);
        if (!file.exists) throw new Error('JPEG file was not created.');

        // Python reads the JPEG and returns its real pixel dimensions with the
        // detection result, so sending preview width/height here was redundant.
        var out = { id: id, path: file.fsName };
        tempFiles.push(file);

        stage = 'close Smart Object contents';
        doc.close(false);
        smartDoc = null;
        app.activeDocument = sourceDoc;
        return out;
    } catch (e) {
        try {
            if (smartDoc) {
                app.activeDocument = smartDoc;
                doc.close(false);
                smartDoc = null;
            }
        } catch (ignore0) { }
        try { app.activeDocument = sourceDoc; } catch (ignore1) { }
        try { if (file && file.exists) file.remove(); } catch (ignore2) { }
        throw new Error('Cannot create JPEG preview for layer ' + id + ' [' + stage + ']: ' + e.message);
    } finally {
        try { app.activeDocument = sourceDoc; } catch (ignore3) { }
    }
}

function convertActiveLayerToSmartObject() {
    executeAction(stringIDToTypeID('newPlacedLayer'), undefined, DialogModes.NO);
}

function openActiveSmartObjectContents() {
    executeAction(stringIDToTypeID('placedLayerEditContents'), undefined, DialogModes.NO);
}


function reselectLayers(ids) {
    if (!ids || !ids.length) return;
    // First selection replaces the current layer selection; the rest are added.
    lr.selectLayer(ids[0], false);
    for (var i = 1; i < ids.length; i++) lr.selectLayer(ids[i], true);
}

function cleanupTempFiles(files) {
    for (var i = 0; i < files.length; i++) {
        try { if (files[i] && files[i].exists) files[i].remove(); } catch (e) { }
    }
}

function cleanupStaleTempFiles() {
    try {
        var files = Folder.temp.getFiles('align_fit_*.jpg'),
            cutoff = (new Date()).getTime() - 60 * 60 * 1000;
        for (var i = 0; i < files.length; i++) {
            try {
                if (!(files[i] instanceof File) || !files[i].exists) continue;
                var modified = files[i].modified;
                // Never delete a preview that may belong to another active Photoshop
                // instance. Only clean files that are clearly stale.
                if (modified && modified.getTime() < cutoff) files[i].remove();
            } catch (e) { }
        }
    } catch (ignore) { }
}


function findFrameById(frames, id) {
    for (var i = 0; i < frames.length; i++) {
        if (String(frames[i].id) == String(id)) return frames[i];
    }
    return null;
}


function alignLayerBounds(subject, frame) {
    // Dedicated Cover mode: center the complete layer in the frame and scale it
    // just enough to cover the frame in both dimensions. Object margins/offsets
    // are intentionally ignored in this mode.
    var layer = doc.descToObject(lr.getProperty('boundsNoEffects', false, subject.id));
    if (!layer || !(Number(layer.width) > 0) || !(Number(layer.height) > 0)) {
        throw new Error(L(str.errLayerBounds));
    }
    layer.center = {
        x: Number(layer.left) + Number(layer.width) / 2,
        y: Number(layer.top) + Number(layer.height) / 2
    };

    var bleed = FINAL_BLEED_PX > 0 ? FINAL_BLEED_PX : 0,
        requiredW = Number(frame.width) + bleed * 2,
        requiredH = Number(frame.height) + bleed * 2,
        scaleW = requiredW / Number(layer.width),
        scaleH = requiredH / Number(layer.height),
        scale = Math.max(scaleW, scaleH) * 100,
        dX = Number(frame.center.x) - layer.center.x,
        dY = Number(frame.center.y) - layer.center.y;

    lr.transform(dX, dY, scale, layer.center.x, layer.center.y);
}

function getObjectPlacementSolution(subject, frame) {
    // Pure geometry shared by both matching and the final transform. Matching a
    // photo to a frame therefore evaluates the same composition that will later
    // be applied in Photoshop.
    var layer = subject.layer,
        layerW = Number(layer.width),
        layerH = Number(layer.height),
        subjectW = Number(subject.width),
        subjectH = Number(subject.height),
        frameW = Number(frame.width),
        frameH = Number(frame.height);

    if (!(layerW > 0) || !(layerH > 0) || !(subjectW > 0) || !(subjectH > 0) || !(frameW > 0) || !(frameH > 0)) return null;

    var localLeft = Math.max(0, Number(subject.left) - Number(layer.left)),
        localTop = Math.max(0, Number(subject.top) - Number(layer.top)),
        localRight = Math.min(layerW, Number(subject.right) - Number(layer.left)),
        localBottom = Math.min(layerH, Number(subject.bottom) - Number(layer.top)),
        visualCenterLocalX = isFiniteNumber(Number(subject.visualCenterX)) ?
            Number(subject.visualCenterX) - Number(layer.left) : (localLeft + localRight) / 2,
        rightSpace = Math.max(0, layerW - localRight),
        bottomSpace = Math.max(0, layerH - localBottom),
        desiredTop = frameH * ((frame.vertical ? cfg.vTop : cfg.hTop) / 100),
        desiredBottom = frameH * ((frame.vertical ? cfg.vBottom : cfg.hBottom) / 100),
        desiredSide = frameW * ((frame.vertical ? cfg.vSide : cfg.hSide) / 100),
        preferredBleed = FINAL_BLEED_PX > 0 ? FINAL_BLEED_PX : 0,
        eps = 0.000001,
        // When the detected object reaches the bottom edge of the source layer,
        // its lower boundary is not a trustworthy end of the person/group: the
        // body is usually cropped by the original photograph (head-and-shoulders,
        // waist-up portrait, etc.). Treat that as an open-bottom object and use
        // the top-anchored composition even if the rectangular bbox could be
        // mathematically fitted inside the frame. A small relative tolerance also
        // absorbs preview scaling / segmentation rounding.
        edgeToleranceX = Math.max(2, layerW * 0.0025),
        edgeToleranceY = Math.max(2, layerH * 0.0025),
        croppedAtLeft = localLeft <= edgeToleranceX,
        croppedAtRight = rightSpace <= edgeToleranceX,
        croppedAtBottom = bottomSpace <= edgeToleranceY;

    visualCenterLocalX = Math.max(localLeft, Math.min(localRight, visualCenterLocalX));

    function clampValue(v, lo, hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    function solveFit(bleed) {
        var side = desiredSide,
            topMargin = desiredTop,
            bottomMargin = desiredBottom,
            innerW = frameW - side * 2,
            innerH = frameH - topMargin - bottomMargin;
        if (!(innerW > 0) || !(innerH > 0)) return null;

        // Requested margins define the preferred scale. Side margins are softer
        // than keeping the complete object visible and centered: if the photo
        // needs a little more scale to cover the frame while the object can still
        // remain centered, increase the scale instead of shifting the object.
        var halfInnerW = innerW / 2,
            visualLeft = visualCenterLocalX - localLeft,
            visualRight = localRight - visualCenterLocalX,
            sDesiredX = Number.POSITIVE_INFINITY,
            sDesiredY = innerH / subjectH,
            sDesired;
        // A side that coincides with the source-image edge is an open/cropped
        // object boundary, not a real end of the person/group. Do not use that
        // side to limit scale or to pull the visual center toward the frame edge.
        if (!croppedAtLeft && visualLeft > eps) sDesiredX = Math.min(sDesiredX, halfInnerW / visualLeft);
        if (!croppedAtRight && visualRight > eps) sDesiredX = Math.min(sDesiredX, halfInnerW / visualRight);
        if (!isFiniteNumber(sDesiredX)) sDesiredX = innerW / subjectW;
        sDesired = Math.min(sDesiredX, sDesiredY);
        if (!(sDesired > 0)) return null;

        // Free-placement feasibility: the layer must cover the frame and the
        // complete detected object must remain inside it. These bounds say that
        // some translation exists; centered placement is tested separately below.
        var sMinHard = Math.max(
                (frameW + bleed * 2) / layerW,
                (frameH + bleed * 2) / layerH
            ),
            sMaxXHard = (!croppedAtLeft && !croppedAtRight) ? frameW / subjectW : Number.POSITIVE_INFINITY,
            sMaxHard = Math.min(sMaxXHard, frameH / subjectH);

        if (bleed > 0) {
            if ((!croppedAtLeft && localLeft <= eps) ||
                (!croppedAtRight && rightSpace <= eps) ||
                localTop <= eps || bottomSpace <= eps) return null;
            if (!croppedAtLeft) sMinHard = Math.max(sMinHard, bleed / localLeft);
            if (!croppedAtRight) sMinHard = Math.max(sMinHard, bleed / rightSpace);
            sMinHard = Math.max(sMinHard, bleed / localTop, bleed / bottomSpace);
        }
        if (sMinHard > sMaxHard + eps) return null;

        var objectCenterLocalY = (localTop + localBottom) / 2,
            targetX = Number(frame.center.x),
            targetY = Number(frame.top) + topMargin + innerH / 2,
            leftLayerSpan = visualCenterLocalX,
            rightLayerSpan = layerW - visualCenterLocalX,
            topLayerSpan = objectCenterLocalY,
            bottomLayerSpan = layerH - objectCenterLocalY,
            leftObjectSpan = visualCenterLocalX - localLeft,
            rightObjectSpan = localRight - visualCenterLocalX,
            topObjectSpan = objectCenterLocalY - localTop,
            bottomObjectSpan = localBottom - objectCenterLocalY,
            inf = Number.POSITIVE_INFINITY;

        function coverMin(target, frameLow, frameHigh, beforeSpan, afterSpan) {
            var m = 0;
            if (beforeSpan > eps) m = Math.max(m, (target - (frameLow - bleed)) / beforeSpan);
            else if (target > frameLow - bleed + eps) return inf;
            if (afterSpan > eps) m = Math.max(m, ((frameHigh + bleed) - target) / afterSpan);
            else if (target < frameHigh + bleed - eps) return inf;
            return Math.max(0, m);
        }

        function containMax(target, frameLow, frameHigh, beforeSpan, afterSpan) {
            var m = inf;
            if (beforeSpan > eps) m = Math.min(m, (target - frameLow) / beforeSpan);
            else if (target < frameLow - eps) return -1;
            if (afterSpan > eps) m = Math.min(m, (frameHigh - target) / afterSpan);
            else if (target > frameHigh + eps) return -1;
            return m;
        }

        var xCenterMin = coverMin(targetX, Number(frame.left), Number(frame.right), leftLayerSpan, rightLayerSpan),
            xCenterMax = inf,
            yCenterMin = coverMin(targetY, Number(frame.top), Number(frame.bottom), topLayerSpan, bottomLayerSpan),
            yCenterMax = containMax(targetY, Number(frame.top), Number(frame.bottom), topObjectSpan, bottomObjectSpan);
        if (!croppedAtLeft && leftObjectSpan > eps) xCenterMax = Math.min(xCenterMax, (targetX - Number(frame.left)) / leftObjectSpan);
        if (!croppedAtRight && rightObjectSpan > eps) xCenterMax = Math.min(xCenterMax, (Number(frame.right) - targetX) / rightObjectSpan);

        function hardIntervals(scale) {
            return {
                xLow: Math.max(
                    croppedAtLeft ? -inf : Number(frame.left) - scale * localLeft,
                    Number(frame.right) + bleed - scale * layerW
                ),
                xHigh: Math.min(
                    croppedAtRight ? inf : Number(frame.right) - scale * localRight,
                    Number(frame.left) - bleed
                ),
                yLow: Math.max(
                    Number(frame.top) - scale * localTop,
                    Number(frame.bottom) + bleed - scale * layerH
                ),
                yHigh: Math.min(
                    Number(frame.bottom) - scale * localBottom,
                    Number(frame.top) - bleed
                )
            };
        }

        function makeResult(scale, tx, ty) {
            return {
                scale: scale,
                tx: tx,
                ty: ty,
                oversized: false,
                bleed: bleed,
                desiredTop: desiredTop,
                desiredBottom: desiredBottom,
                desiredSide: desiredSide,
                innerW: innerW,
                innerH: innerH,
                localLeft: localLeft,
                localTop: localTop,
                localRight: localRight,
                localBottom: localBottom,
                visualCenterLocalX: visualCenterLocalX,
                croppedAtLeft: croppedAtLeft,
                croppedAtRight: croppedAtRight
            };
        }

        // Best case: preserve both requested centers exactly. If the preferred
        // scale is too small for the layer to cover the frame, enlarge only as
        // much as necessary, provided the complete object still fits.
        var centeredMin = Math.max(sMinHard, xCenterMin, yCenterMin),
            centeredMax = Math.min(sMaxHard, xCenterMax, yCenterMax),
            scale, h, preferredX, preferredY, desiredYLow, desiredYHigh, tx, ty;
        if (centeredMin <= centeredMax + eps) {
            scale = Math.max(sDesired, centeredMin);
            if (scale <= centeredMax + eps) {
                return makeResult(
                    scale,
                    targetX - scale * visualCenterLocalX,
                    targetY - scale * objectCenterLocalY
                );
            }
        }

        // Horizontal visual centering is the strongest positional rule. Even if
        // exact vertical centering is impossible, try every admissible scale that
        // keeps the complete object visible before allowing an X shift.
        var xOnlyMin = Math.max(sMinHard, xCenterMin),
            xOnlyMax = Math.min(sMaxHard, xCenterMax);
        if (xOnlyMin <= xOnlyMax + eps) {
            scale = Math.max(sDesired, xOnlyMin);
            if (scale > xOnlyMax) scale = xOnlyMax;
            h = hardIntervals(scale);
            if (h.xLow <= h.xHigh + eps && h.yLow <= h.yHigh + eps) {
                preferredY = targetY - scale * objectCenterLocalY;
                desiredYLow = Math.max(h.yLow, Number(frame.top) + topMargin - scale * localTop);
                desiredYHigh = Math.min(h.yHigh, Number(frame.bottom) - bottomMargin - scale * localBottom);
                if (desiredYLow <= desiredYHigh + eps) ty = clampValue(preferredY, desiredYLow, desiredYHigh);
                else ty = clampValue(preferredY, h.yLow, h.yHigh);
                return makeResult(scale, targetX - scale * visualCenterLocalX, ty);
            }
        }

        // If exact X centering is genuinely impossible, preserve the preferred
        // vertical center when that can still be done with the complete object.
        var yOnlyMin = Math.max(sMinHard, yCenterMin),
            yOnlyMax = Math.min(sMaxHard, yCenterMax);
        if (yOnlyMin <= yOnlyMax + eps) {
            scale = Math.max(sDesired, yOnlyMin);
            if (scale > yOnlyMax) scale = yOnlyMax;
            h = hardIntervals(scale);
            if (h.xLow <= h.xHigh + eps && h.yLow <= h.yHigh + eps) {
                preferredX = targetX - scale * visualCenterLocalX;
                return makeResult(scale, clampValue(preferredX, h.xLow, h.xHigh), targetY - scale * objectCenterLocalY);
            }
        }

        // Last resort for a still fully visible object: use the preferred scale
        // plus only the minimum translation required by layer coverage. This path
        // is reached only when no scale can keep either preferred center exactly.
        scale = Math.max(sDesired, sMinHard);
        if (scale > sMaxHard) scale = sMaxHard;
        h = hardIntervals(scale);
        if (h.xLow > h.xHigh + eps || h.yLow > h.yHigh + eps) return null;

        preferredX = targetX - scale * visualCenterLocalX;
        preferredY = targetY - scale * objectCenterLocalY;
        desiredYLow = Math.max(h.yLow, Number(frame.top) + topMargin - scale * localTop);
        desiredYHigh = Math.min(h.yHigh, Number(frame.bottom) - bottomMargin - scale * localBottom);
        tx = clampValue(preferredX, h.xLow, h.xHigh);
        if (desiredYLow <= desiredYHigh + eps) ty = clampValue(preferredY, desiredYLow, desiredYHigh);
        else ty = clampValue(preferredY, h.yLow, h.yHigh);
        return makeResult(scale, tx, ty);
    }

    function solveOversized(bleed) {
        var anchorLocalX = visualCenterLocalX,
            leftFromAnchor = anchorLocalX,
            rightFromAnchor = layerW - anchorLocalX,
            belowTopAnchor = layerH - localTop;

        if (!(leftFromAnchor > eps) || !(rightFromAnchor > eps) || !(belowTopAnchor > eps)) return null;

        var targetX = Number(frame.center.x),
            innerW = frameW - desiredSide * 2,
            // First establish the object scale from its horizontal composition,
            // not from whichever image edge happens to be closest to the frame.
            // The layer-cover requirement may enlarge it further, but must never
            // make the photograph edge the primary alignment target.
            visualLeft = anchorLocalX - localLeft,
            visualRight = localRight - anchorLocalX,
            halfInnerW = Math.max(eps, innerW / 2),
            scaleObjectX = Number.POSITIVE_INFINITY,
            scaleLR;

        if (visualLeft > eps) scaleObjectX = Math.min(scaleObjectX, halfInnerW / visualLeft);
        if (visualRight > eps) scaleObjectX = Math.min(scaleObjectX, halfInnerW / visualRight);
        if (!isFiniteNumber(scaleObjectX)) scaleObjectX = innerW > eps ? innerW / subjectW : frameW / subjectW;

        scaleLR = Math.max(
            (targetX - (Number(frame.left) - bleed)) / leftFromAnchor,
            ((Number(frame.right) + bleed) - targetX) / rightFromAnchor
        );
        var scaleDesired = Math.max(
                scaleObjectX,
                scaleLR,
                (frameH + bleed - desiredTop) / belowTopAnchor
            ),
            topCoveredWithDesired = localTop > eps ?
                (localTop * scaleDesired >= desiredTop + bleed - eps) :
                (desiredTop <= eps && bleed <= eps),
            scale,
            topMargin;

        if (topCoveredWithDesired) {
            scale = scaleDesired;
            topMargin = desiredTop;
        } else {
            if (localTop <= eps && bleed > 0) return null;
            scale = Math.max(scaleObjectX, scaleLR, (frameH + bleed * 2) / layerH);
            if (localTop > eps) scale = Math.max(scale, bleed / localTop);
            topMargin = localTop * scale - bleed;
            if (topMargin < 0) topMargin = 0;
            if (topMargin > desiredTop) topMargin = desiredTop;
        }

        if (!(scale > 0)) return null;

        var tx = targetX - scale * anchorLocalX,
            ty = Number(frame.top) + topMargin - scale * localTop,
            left = tx,
            top = ty,
            right = tx + scale * layerW,
            bottom = ty + scale * layerH,
            extra = 1;

        if (left > Number(frame.left) - bleed + eps) {
            extra = Math.max(extra, (targetX - (Number(frame.left) - bleed)) / (scale * leftFromAnchor));
        }
        if (right < Number(frame.right) + bleed - eps) {
            extra = Math.max(extra, ((Number(frame.right) + bleed) - targetX) / (scale * rightFromAnchor));
        }
        if (bottom < Number(frame.bottom) + bleed - eps) {
            extra = Math.max(extra, ((Number(frame.bottom) + bleed) - (Number(frame.top) + topMargin)) / (scale * belowTopAnchor));
        }
        if (top > Number(frame.top) - bleed + eps && localTop > eps) {
            extra = Math.max(extra, (topMargin + bleed) / (scale * localTop));
        }

        if (extra > 1 + eps) {
            scale *= extra;
            tx = targetX - scale * anchorLocalX;
            ty = Number(frame.top) + topMargin - scale * localTop;
        }

        return {
            scale: scale,
            tx: tx,
            ty: ty,
            oversized: true,
            bleed: bleed,
            topMargin: topMargin,
            desiredTop: desiredTop,
            desiredBottom: desiredBottom,
            desiredSide: desiredSide,
            innerW: Math.max(eps, frameW - desiredSide * 2),
            innerH: Math.max(eps, frameH - desiredTop - desiredBottom),
            localLeft: localLeft,
            localTop: localTop,
            localRight: localRight,
            localBottom: localBottom,
            visualCenterLocalX: visualCenterLocalX,
            croppedAtLeft: croppedAtLeft,
            croppedAtRight: croppedAtRight
        };
    }

    // The anti-seam bleed must never be the reason the subject is cropped.
    // If the detected object reaches the bottom edge of the source photograph,
    // do not use the full-object centering branch: the bbox is open at the bottom
    // and would create an artificial large top gap. In that case use the same
    // top anchor as for a genuinely oversized object.
    function chooseFitSolution(a, b) {
        if (!a) return b;
        if (!b) return a;
        var anchorY = (localTop + localBottom) / 2,
            targetY = Number(frame.top) + desiredTop + (frameH - desiredTop - desiredBottom) / 2,
            ax = Number(a.tx) + Number(a.scale) * visualCenterLocalX,
            bx = Number(b.tx) + Number(b.scale) * visualCenterLocalX,
            ay = Number(a.ty) + Number(a.scale) * anchorY,
            by = Number(b.ty) + Number(b.scale) * anchorY,
            dxA = Math.abs(ax - Number(frame.center.x)),
            dxB = Math.abs(bx - Number(frame.center.x)),
            dyA = Math.abs(ay - targetY),
            dyB = Math.abs(by - targetY),
            centerTol = 0.0001;

        // A two-pixel anti-seam bleed is lower priority than the actual subject
        // composition. Prefer the solution that keeps the visual center exact;
        // only when centering is equivalent do we keep the bleed.
        if (Math.abs(dxA - dxB) > centerTol) return dxA < dxB ? a : b;
        if (Math.abs(dyA - dyB) > centerTol) return dyA < dyB ? a : b;
        return Number(a.bleed) >= Number(b.bleed) ? a : b;
    }

    var solution = null;
    if (!croppedAtBottom) {
        var fitWithBleed = solveFit(preferredBleed),
            fitWithoutBleed = preferredBleed > 0 ? solveFit(0) : null;
        solution = chooseFitSolution(fitWithBleed, fitWithoutBleed);
    }
    if (!solution) {
        solution = solveOversized(preferredBleed);
        if (!solution && preferredBleed > 0) solution = solveOversized(0);
    }
    return solution;
}

function objectPlacementCost(subject, frame) {
    // Lower is better. There is deliberately no hard portrait/landscape rule:
    // a frame of the opposite orientation may win when the detected object fits
    // it more naturally. The score measures the composition produced by the real
    // placement solver, not the orientation of the source photograph.
    var solution = getObjectPlacementSolution(subject, frame);
    if (!solution) return 1000000;

    var scale = Number(solution.scale),
        frameW = Number(frame.width),
        frameH = Number(frame.height),
        objectW = Number(subject.width) * scale,
        objectH = Number(subject.height) * scale,
        innerW = Math.max(0.000001, Number(solution.innerW)),
        innerH = Math.max(0.000001, Number(solution.innerH)),
        ratioCost = Math.abs(Math.log((objectW / objectH) / (innerW / innerH))),
        objectLeft = Number(solution.tx) + scale * Number(solution.localLeft),
        objectTop = Number(solution.ty) + scale * Number(solution.localTop),
        objectRight = Number(solution.tx) + scale * Number(solution.localRight),
        objectBottom = Number(solution.ty) + scale * Number(solution.localBottom);

    if (!solution.oversized) {
        var preferredCenterX = Number(frame.center.x),
            preferredCenterY = Number(frame.top) + Number(solution.desiredTop) + innerH / 2,
            actualCenterX = Number(solution.tx) + scale * Number(solution.visualCenterLocalX),
            actualCenterY = (objectTop + objectBottom) / 2,
            centerDx = Math.abs(actualCenterX - preferredCenterX) / Math.max(1, frameW),
            centerDy = Math.abs(actualCenterY - preferredCenterY) / Math.max(1, frameH);

        // Ratio describes how completely the object fills the usable rectangle;
        // center shift penalizes pairs where insufficient image around the object
        // would force the final composition away from the requested center.
        return ratioCost * 4 + (centerDx + centerDy) * 8;
    }

    var ix1 = Math.max(Number(frame.left), objectLeft),
        iy1 = Math.max(Number(frame.top), objectTop),
        ix2 = Math.min(Number(frame.right), objectRight),
        iy2 = Math.min(Number(frame.bottom), objectBottom),
        visibleArea = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1),
        objectArea = Math.max(0.000001, objectW * objectH),
        cropFraction = 1 - Math.min(1, visibleArea / objectArea),
        topLoss = Math.max(0, Number(solution.desiredTop) - Number(solution.topMargin || 0)) / Math.max(1, frameH);

    // Oversized placement is normal and valid, but a centered full-object fit is
    // preferred when quality is otherwise similar. Among oversized choices,
    // prefer less object cropping and better preservation of the requested top gap.
    return 2 + ratioCost * 4 + cropFraction * 8 + topLoss * 4;
}

function alignLayer(subject, frame) {
    var solution = getObjectPlacementSolution(subject, frame);
    if (!solution) throw new Error('Invalid object/frame geometry.');

    // Apply the already solved final geometry using a transform anchor that
    // belongs to the detected object, not to the complete photo layer. This is
    // intentionally close to the original script's transform model:
    //   - normal fit: scale around the object's center;
    //   - oversized fit: scale around the top-center of the object.
    // The target point is derived from solution.tx/ty, so changing the anchor
    // does not change the placement solver's final geometry; it only makes the
    // Photoshop transform itself preserve the important object point directly.
    var layer = subject.layer,
        scale = Number(solution.scale),
        anchorX, anchorY,
        targetX, targetY;

    if (solution.oversized) {
        // Portraits and groups that cannot be fully contained are enlarged from
        // their top-center. The whole detected group therefore stays centered
        // horizontally while the top of the group remains the vertical anchor.
        anchorX = isFiniteNumber(Number(subject.visualCenterX)) ? Number(subject.visualCenterX) : (Number(subject.left) + Number(subject.right)) / 2;
        anchorY = Number(subject.top);
        targetX = Number(solution.tx) + scale * ((anchorX - Number(layer.left)));
        targetY = Number(solution.ty) + scale * ((anchorY - Number(layer.top)));
    } else {
        // For a normal fit the detected object's center is the transform anchor.
        // If cover constraints forced a minimal shift, targetX/targetY reproduce
        // that solved center exactly rather than re-centering the photo layer.
        anchorX = isFiniteNumber(Number(subject.visualCenterX)) ? Number(subject.visualCenterX) : Number(subject.center.x);
        anchorY = Number(subject.center.y);
        targetX = Number(solution.tx) + scale * ((anchorX - Number(layer.left)));
        targetY = Number(solution.ty) + scale * ((anchorY - Number(layer.top)));
    }

    var dX = targetX - anchorX,
        dY = targetY - anchorY;

    lr.transform(dX, dY, scale * 100, anchorX, anchorY);
}
function AM(target, order) {
    var s2t = stringIDToTypeID,
        t2s = typeIDToStringID;
    target = s2t(target)
    this.getProperty = function (property, descMode, id, idxMode) {
        property = s2t(property);
        (r = new ActionReference()).putProperty(s2t('property'), property);
        id != undefined ? (idxMode ? r.putIndex(target, id) : r.putIdentifier(target, id)) :
            r.putEnumerated(target, s2t('ordinal'), order ? s2t(order) : s2t('targetEnum'));
        return descMode ? executeActionGet(r) : getDescValue(executeActionGet(r), property)
    }
    this.hasProperty = function (property, id, idxMode) {
        property = s2t(property);
        (r = new ActionReference()).putProperty(s2t('property'), property);
        id ? (idxMode ? r.putIndex(target, id) : r.putIdentifier(target, id))
            : r.putEnumerated(target, s2t('ordinal'), order ? s2t(order) : s2t('targetEnum'));
        return executeActionGet(r).hasKey(property)
    }
    this.descToObject = function (d) {
        var o = {}
        for (var i = 0; i < d.count; i++) {
            var k = d.getKey(i)
            o[t2s(k)] = getDescValue(d, k)
        }
        return o
    }
    this.selectLayer = function (id, add) {
        add = (add == undefined) ? add = false : add;
        (r = new ActionReference()).putIdentifier(s2t('layer'), id);
        (d = new ActionDescriptor()).putReference(s2t('null'), r);
        if (add) { d.putEnumerated(s2t('selectionModifier'), s2t('selectionModifierType'), s2t('addToSelection')) }
        d.putBoolean(s2t('makeVisible'), false)
        executeAction(s2t('select'), d, DialogModes.NO)
    }
    this.moveLayer = function (from, to) {
        (r = new ActionReference()).putIndex(s2t('layer'), from);
        (d = new ActionDescriptor()).putReference(s2t('null'), r);
        (r1 = new ActionReference()).putIndex(s2t('layer'), to);
        d.putReference(s2t('to'), r1);
        executeAction(s2t('move'), d, DialogModes.NO);
    }
    this.setQuickMask = function (mode) {
        (r = new ActionReference()).putProperty(s2t('property'), s2t('quickMask'));
        r.putEnumerated(s2t('document'), s2t('ordinal'), s2t('targetEnum'));
        (d = new ActionDescriptor()).putReference(s2t('null'), r);
        executeAction(mode ? s2t('set') : s2t('clearEvent'), d, DialogModes.NO);
    }
    this.levels = function (paramsArray) {
        var left = paramsArray[0],
            gamma = paramsArray[1],
            right = paramsArray[2];
        (d = new ActionDescriptor()).putEnumerated(s2t('presetKind'), s2t('presetKindType'), s2t('presetKindCustom'));
        (r = new ActionReference()).putEnumerated(s2t('channel'), s2t('ordinal'), s2t('targetEnum'));
        (d1 = new ActionDescriptor()).putReference(s2t('channel'), r);
        (l = new ActionList()).putInteger(left);
        l.putInteger(right);
        d1.putList(s2t('input'), l);
        d1.putDouble(s2t('gamma'), gamma);
        (l1 = new ActionList()).putObject(s2t('levelsAdjustment'), d1);
        d.putList(s2t('adjustment'), l1);
        executeAction(s2t('levels'), d, DialogModes.NO)
    }
    this.deselect = function () {
        (r = new ActionReference()).putProperty(s2t('channel'), s2t('selection'));
        (d = new ActionDescriptor()).putReference(s2t('null'), r);
        d.putEnumerated(s2t('to'), s2t('ordinal'), s2t('none'));
        executeAction(s2t('set'), d, DialogModes.NO);
    }
    this.autoCutout = function () {
        (d = new ActionDescriptor()).putBoolean(s2t('sampleAllLayers'), false);
        executeAction(s2t('autoCutout'), d, DialogModes.NO);
    }
    this.getSelectionMode = function () {
        (r = new ActionReference()).putProperty(s2t('property'), p = s2t('imageProcessingPrefs'));
        r.putEnumerated(s2t('application'), s2t('ordinal'), s2t('targetEnum'));
        return t2s(executeActionGet(r).getObjectValue(p).getEnumerationValue(s2t('imageProcessingSelectSubjectPrefs')));
    }
    this.setSelectionMode = function (state) {
        (r = new ActionReference()).putProperty(s2t('property'), s2t('imageProcessingPrefs'));
        r.putEnumerated(s2t('application'), s2t('ordinal'), s2t('targetEnum'));
        (d = new ActionDescriptor()).putReference(s2t('null'), r);
        (d1 = new ActionDescriptor()).putEnumerated(s2t('imageProcessingSelectSubjectPrefs'), s2t('imageProcessingSelectSubjectPrefs'), s2t(state));
        d.putObject(s2t('to'), s2t('imageProcessingPrefs'), d1);
        executeAction(s2t('set'), d, DialogModes.NO);
    }
    this.groupCurrentLayer = function () {
        (r = new ActionReference()).putEnumerated(s2t('layer'), s2t('ordinal'), s2t('targetEnum'));
        (d = new ActionDescriptor()).putReference(s2t('null'), r);
        executeAction(s2t('groupEvent'), d, DialogModes.NO);
    }
    this.transform = function (dX, dY, scale, x, y) {
        (r = new ActionReference()).putEnumerated(s2t('layer'), s2t('ordinal'), s2t('targetEnum'));
        (d = new ActionDescriptor()).putReference(s2t('null'), r);
        d.putEnumerated(s2t('freeTransformCenterState'), s2t('quadCenterState'), s2t('QCSIndependent'));
        ((d1 = new ActionDescriptor())).putUnitDouble(s2t('horizontal'), s2t('pixelsUnit'), x);
        d1.putUnitDouble(s2t('vertical'), s2t('pixelsUnit'), y);
        d.putObject(s2t('position'), s2t('paint'), d1);
        (d2 = new ActionDescriptor()).putUnitDouble(s2t('horizontal'), s2t('pixelsUnit'), dX);
        d2.putUnitDouble(s2t('vertical'), s2t('pixelsUnit'), dY);
        d.putObject(s2t('offset'), s2t('offset'), d2);
        d.putUnitDouble(s2t('width'), s2t('percentUnit'), scale);
        d.putUnitDouble(s2t('height'), s2t('percentUnit'), scale);
        d.putEnumerated(s2t('interfaceIconFrameDimmed'), s2t('interpolationType'), s2t('bicubic'));
        if (!isFiniteNumber(dX) || !isFiniteNumber(dY) || !isFiniteNumber(scale) || !isFiniteNumber(x) || !isFiniteNumber(y) || scale <= 0) {
            throw new Error('Invalid Transform geometry: offset=(' + dX + ', ' + dY + '), scale=' + scale + ', center=(' + x + ', ' + y + ')');
        }
        try {
            executeAction(s2t('transform'), d, DialogModes.NO);
        } catch (transformError) {
            var info = [];
            try { info.push('layerID=' + lr.getProperty('layerID')); } catch (e0) { }
            try { info.push('name=' + lr.getProperty('name')); } catch (e1) { }
            try { info.push('group=' + lr.getProperty('group')); } catch (e2) { }
            try { info.push('visible=' + lr.getProperty('visible')); } catch (e21) { }
            try {
                var tb = doc.descToObject(lr.getProperty('boundsNoEffects'));
                info.push('bounds=[' + tb.left + ',' + tb.top + ',' + tb.right + ',' + tb.bottom + ']');
            } catch (e3) { }
            info.push('offset=(' + dX + ',' + dY + ')');
            info.push('scale=' + scale);
            info.push('center=(' + x + ',' + y + ')');
            throw new Error(transformError.message + '\nTransform context: ' + info.join('; '));
        }
    }
    this.makeSelection = function (id, mask) {
        (r = new ActionReference()).putProperty(s2t('channel'), s2t('selection'));
        (d = new ActionDescriptor()).putReference(s2t('null'), r);
        r1 = new ActionReference();
        if (mask) {
            r1.putEnumerated(s2t("path"), s2t("path"), s2t("vectorMask"));
        } else {
            r1.putEnumerated(s2t('channel'), s2t('channel'), s2t('transparencyEnum'));
        }
        r1.putIdentifier(s2t('layer'), id);
        d.putReference(s2t('to'), r1);
        executeAction(s2t('set'), d, DialogModes.NO);
    }
    this.makeSelectionFromPath = function () {
        (r = new ActionReference()).putProperty(s2t('channel'), s2t('selection'));
        (d = new ActionDescriptor()).putReference(s2t('null'), r);
        (r1 = new ActionReference()).putProperty(s2t('path'), s2t('workPath'));
        d.putReference(s2t('to'), r1);
        d.putBoolean(s2t('vectorMaskParams'), true);
        executeAction(s2t('set'), d, DialogModes.NO);
    }
    this.deleteCurrentPath = function () {
        (r = new ActionReference()).putProperty(s2t('path'), s2t('workPath'));
        (d = new ActionDescriptor()).putReference(s2t('null'), r);
        executeAction(s2t('delete'), d, DialogModes.NO);
    }
    this.createPath = function () {
        (r = new ActionReference()).putClass(s2t('path'));
        (d = new ActionDescriptor()).putReference(s2t('null'), r);
        (r1 = new ActionReference()).putProperty(s2t('selectionClass'), s2t('selection'));
        d.putReference(s2t('from'), r1);
        d.putUnitDouble(s2t('tolerance'), s2t('pixelsUnit'), 10);
        executeAction(s2t('make'), d, DialogModes.NO);
    }
    this.rasterize = function () {
        (r = new ActionReference()).putEnumerated(s2t('layer'), s2t('ordinal'), s2t('targetEnum'));
        (d = new ActionDescriptor()).putReference(s2t('target'), r);
        executeAction(s2t('rasterizeLayer'), d, DialogModes.NO);
    }
    this.getDocumentInfo = function () {
        // A single document descriptor is faster than several DOM property
        // accesses. Photoshop reports document width/height in points here, so
        // convert them to pixels using the current resolution.
        (r = new ActionReference()).putEnumerated(s2t('document'), s2t('ordinal'), s2t('targetEnum'));
        var dd = executeActionGet(r),
            kw = s2t('width'),
            kh = s2t('height'),
            kr = s2t('resolution'),
            km = s2t('mode'),
            kd = s2t('depth'),
            resolution = dd.hasKey(kr) ? Number(dd.getUnitDoubleValue(kr)) : 0,
            width = dd.hasKey(kw) ? Number(dd.getUnitDoubleValue(kw)) : 0,
            height = dd.hasKey(kh) ? Number(dd.getUnitDoubleValue(kh)) : 0,
            mode = '',
            depth = 0;
        if (resolution > 0) {
            width = width * resolution / 72;
            height = height * resolution / 72;
        }
        if (dd.hasKey(km)) {
            try { mode = t2s(dd.getEnumerationValue(km)); } catch (e0) { }
        }
        if (dd.hasKey(kd)) {
            try { depth = Number(dd.getInteger(kd)); } catch (e1) { }
        }
        return { width: width, height: height, resolution: resolution, mode: mode, depth: depth };
    }
    this.flatten = function () {
        executeAction(s2t('flattenImage'), undefined, DialogModes.NO);
    }
    this.convertToRGB = function () {
        (d = new ActionDescriptor()).putClass(s2t('to'), s2t('RGBColorMode'));
        executeAction(s2t('convertMode'), d, DialogModes.NO);
    }
    this.convertTo8Bit = function () {
        // ScriptListener form of Image > Mode > 8 Bits/Channel.
        (d = new ActionDescriptor()).putInteger(charIDToTypeID('Dpth'), 8);
        executeAction(charIDToTypeID('CnvM'), d, DialogModes.NO);
    }
    this.setScale = function (scale) {
        (d = new ActionDescriptor()).putUnitDouble(s2t('width'), s2t('percentUnit'), scale * 100);
        d.putBoolean(s2t('scaleStyles'), true);
        d.putBoolean(s2t('constrainProportions'), true);
        d.putEnumerated(s2t('interpolation'), s2t('interpolationType'), s2t('bilinear'));
        executeAction(s2t('imageSize'), d, DialogModes.NO);
    }
    this.saveJpegCopy = function (pth, quality) {
        quality = quality == undefined ? 6 : quality;
        (d1 = new ActionDescriptor()).putInteger(s2t('extendedQuality'), quality);
        d1.putEnumerated(s2t('matteColor'), s2t('matteColor'), s2t('none'));
        (d = new ActionDescriptor()).putObject(s2t('as'), s2t('JPEG'), d1);
        d.putPath(s2t('in'), pth);
        d.putBoolean(s2t('copy'), true);
        executeAction(s2t('save'), d, DialogModes.NO);
    }
    this.close = function (save) {
        save = save == true ? s2t('yes') : s2t('no');
        (d = new ActionDescriptor()).putEnumerated(s2t('saving'), s2t('yesNo'), save);
        executeAction(s2t('close'), d, DialogModes.NO);
    }
    this.setLayerVisiblity = function (id, makeVisible) {
        var mode = makeVisible ? "show" : "hide";
        (r = new ActionReference()).putIdentifier(s2t('layer'), id);
        (d = new ActionDescriptor()).putReference(s2t('target'), r);
        executeAction(s2t(mode), d, DialogModes.NO);
    }
    function getDescValue(d, p) {
        switch (d.getType(p)) {
            case DescValueType.OBJECTTYPE: return (d.getObjectValue(p));
            case DescValueType.LISTTYPE: return d.getList(p);
            case DescValueType.REFERENCETYPE: return d.getReference(p);
            case DescValueType.BOOLEANTYPE: return d.getBoolean(p);
            case DescValueType.STRINGTYPE: return d.getString(p);
            case DescValueType.INTEGERTYPE: return d.getInteger(p);
            case DescValueType.LARGEINTEGERTYPE: return d.getLargeInteger(p);
            case DescValueType.DOUBLETYPE: return d.getDouble(p);
            case DescValueType.ALIASTYPE: return d.getPath(p);
            case DescValueType.CLASSTYPE: return d.getClass(p);
            case DescValueType.UNITDOUBLE: return (d.getUnitDoubleValue(p));
            case DescValueType.ENUMERATEDTYPE: return [t2s(d.getEnumerationType(p)), t2s(d.getEnumerationValue(p))];
            default: break;
        };
    }
}
function isFiniteNumber(v) {
    return typeof v == 'number' && !isNaN(v) && isFinite(v);
}

function findApiFile(scriptPath) {
    for (var i = 0; i < API_FILES.length; i++) {
        var apiFile = new File(scriptPath + '/' + API_FILES[i]);
        if (apiFile.exists) return apiFile;
    }
    return null;
}

function getRuntimeInfo() {
    var local = $.getenv('LOCALAPPDATA');
    if (!local) {
        try { local = Folder.userData.parent.fsName + '/Local'; } catch (e) { local = ''; }
    }
    var root = new Folder(local + '/' + RUNTIME_NAME);
    return {
        pythonw: new File(root.fsName + '/venv/Scripts/pythonw.exe'),
        launcher: new File(root.fsName + '/launcher.vbs'),
        humanModel: new File(root.fsName + '/venv/models/human.onnx'),
        faceModel: new File(root.fsName + '/venv/models/face.onnx')
    };
}

function analysisApi(apiHost, portSend, portListen, apiFile, runtime) {
    var requestSeq = 0;

    this.init = function () {
        var result = sendMessage({ type: 'handshake', message: '' }, PING_DELAY, true, true);
        if (isSuccessHandshake(result)) return true;

        // Any reply without request_id is from the pre-0.4.1 protocol. Stop that
        // server even if the delayed packet was an old analyze/match response.
        if (result && result.request_id == undefined) {
            sendMessage({ type: 'exit', message: '' }, 250, true, false);
            $.sleep(250);
            result = null;
        } else if (result && result.type == 'answer' && result.message && result.message.status == 'success') {
            sendMessage({ type: 'exit', message: '' }, 250, true, false);
            $.sleep(250);
            result = null;
        }

        if (!apiFile || !apiFile.exists) throw new Error('Python module not found: ' + API_FILES.join(', '));
        if (!runtime || !runtime.pythonw.exists || !runtime.launcher.exists) {
            throw new Error('AlignFit runtime not found. Run install_runtime.bat once.');
        }

        try {
            $.setenv('ALIGN_FIT_SERVER', apiFile.fsName);
            runtime.launcher.execute();
        } catch (e) {
            throw new Error('Cannot start AlignFit runtime: ' + e.message);
        }

        result = waitForHandshake(INIT_DELAY);
        if (isSuccessHandshake(result)) return true;
        if (result && result.type == 'error') {
            sendMessage({ type: 'exit', message: '' }, 250, true, false);
            throw new Error(result.message);
        }
        throw new Error('Cannot connect to align-fit-api');
    };

    this.sendPayload = function (type, payload, delay) {
        var result = sendMessage({ type: type, message: payload }, delay, true, true);
        if (result) {
            if (result.type == 'answer') return result.message;
            if (result.type == 'error') throw new Error(result.message);
        }
        throw new Error('No response from align-fit-api');
    };

    function isSuccessHandshake(result) {
        return result && result.type == 'answer' && result.message && result.message.status == 'success' && result.message.version == EXPECTED_SERVER_VERSION;
    }

    function waitForHandshake(delay) {
        var t0 = (new Date()).getTime(),
            lastResult = null,
            now = t0;
        while ((now = (new Date()).getTime()) - t0 < delay) {
            var remaining = Math.max(500, delay - (now - t0));
            // If the server is not listening, sendMessage returns immediately. Once
            // it accepts the connection, allow model initialization to finish.
            lastResult = sendMessage({ type: 'handshake', message: '' }, remaining, true, true);
            if (lastResult) break;
            $.sleep(100);
        }
        return lastResult;
    }

    function sendMessage(o, delay, sendData, getData) {
        delay = delay ? delay : INIT_DELAY;
        var requestId = String((new Date()).getTime()) + '-' + (++requestSeq),
            listener = null,
            t1 = 0,
            t2 = 0;
        o.request_id = requestId;

        if (getData) {
            listener = new Socket();
            if (!listener.listen(portListen, 'UTF-8')) return null;
            t1 = (new Date()).getTime();
        }

        if (sendData) {
            var sender = new Socket();
            if (sender.open(apiHost + ':' + portSend, 'UTF-8')) {
                sender.writeln(objectToJSON(o));
                sender.close();
            } else {
                if (listener) listener.close();
                return null;
            }
        }

        if (!getData) return true;
        for (;;) {
            t2 = (new Date()).getTime();
            if (t2 - t1 > delay) {
                if (listener) listener.close();
                return null;
            }
            var answer = listener.poll();
            if (answer != null) {
                var a = null;
                try { a = eval('(' + answer.readln() + ')'); } catch (e) { a = null; }
                try { answer.close(); } catch (e2) { }

                // Ignore delayed replies from an older request. A legacy handshake
                // without request_id is accepted only to detect/stop an old server.
                var legacyHandshake = o.type == 'handshake' && a && a.request_id == undefined;
                if (a && !legacyHandshake && String(a.request_id) != requestId) continue;
                if (!a) continue;

                if (listener) listener.close();
                return a;
            }
            $.sleep(1);
        }
    }

    function objectToJSON(obj) {
        if (obj === null) return 'null';
        var t = typeof obj;
        if (t == 'string') return '"' + escapeJSONString(obj) + '"';
        if (t == 'number') return isFinite(obj) ? String(obj) : 'null';
        if (t == 'boolean') return obj ? 'true' : 'false';
        if (obj instanceof Array) {
            var arr = [];
            for (var i = 0; i < obj.length; i++) arr.push(objectToJSON(obj[i]));
            return '[' + arr.join(',') + ']';
        }
        var result = [];
        for (var key in obj) {
            if (obj.hasOwnProperty(key)) result.push('"' + escapeJSONString(key) + '":' + objectToJSON(obj[key]));
        }
        return '{' + result.join(',') + '}';
    }

    function escapeJSONString(value) {
        return String(value)
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n')
            .replace(/\t/g, '\\t');
    }
}
