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

var SCRIPT_VERSION = '0.7.3',
    UUID = '5a2946a7-c3d1-430b-8527-c854f5bb7241',
    API_HOST = '127.0.0.1',
    API_PORT_SEND = 6320,
    API_PORT_LISTEN = 6321,
    API_FILES = ['lib/align-fit-api.pyw', 'align-fit-api.pyw'],
    RUNTIME_NAME = 'AlignFitRuntime',
    EXPECTED_SERVER_VERSION = '0.6.0',
    PREVIEW_MAX = 1280,
    FINAL_BLEED_PX = 2,
    INIT_DELAY = 15000,
    ANALYZE_DELAY = 120000,
    MATCH_DELAY = 10000,
    PING_DELAY = 500,
    PYTHON_ANALYZE_EXPECTED_MS = 3000,
    PROGRESS_STAGE_TARGET = 0.95,
    API_POLL_INTERVAL = 25,
    API_POLL_SLEEP = 5,
    lr = new AM('layer'),
    doc = new AM('document'),
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
        app.doProgressSegmentTask(10, 0, 100, 'prepareRunContextStage();');

        app.doProgressSegmentTask(90, 10, 100, 'runPreparedStages();');
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
    if (runCtx) runCtx.placementSolutions = null;
    if (runError) throw runError;
}

function prepareRunContextStage() {
    app.changeProgressText(L(str.prepareLayers));
    runCtx = createRunContext();
    preparationProgress(100, 100);
}

function preparationProgress(value, total) {
    if (app.updateProgress(value, total) === false) throw makeUserCancelError();
}

function runPreparedStages() {
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
}

function createRunContext() {
    var sourceDoc = activeDocument,
        targetList = doc.getProperty('targetLayersIDs'),
        targetIds = [],
        layerMeta = {},
        tempFiles = [],
        metadata = new LayerMetadataCache();

    for (var ti = 0; ti < targetList.count; ti++) {
        targetIds.push(targetList.getReference(ti).getIdentifier('layerID'));
    }
    if (!targetIds.length) throw new Error(L(str.errLayers));

    var clippedAtStart = 0;
    for (var mi = 0; mi < targetIds.length; mi++) {
        var mid = targetIds[mi], info = metadata.byId(mid),
            isClipped = info.clipped;
        layerMeta[String(mid)] = {
            name: info.name,
            color: info.color,
            clipped: isClipped,
            clippingBaseId: null
        };
        if (isClipped) clippedAtStart++;
        preparationProgress(30 * (mi + 1), 100 * targetIds.length);
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
            var cid = targetIds[ci], baseId = metadata.clippingBase(cid);
            if (!baseId) throw new Error('Cannot find clipping base for layer: ' + layerMeta[String(cid)].name);
            layerMeta[String(cid)].clippingBaseId = baseId;
            preparationProgress(30 + 70 * (ci + 1) / targetIds.length, 100);
        }
    } else {
        // Decide normal-vs-fallback BEFORE object detection. This prevents the
        // common-reference layer from being unnecessarily analyzed as a subject.
        var selectedSet = {}, subjectCounts = {}, from = metadata.backgroundOffset ? 0 : 1,
            len = doc.getProperty('numberOfLayers');
        for (var si = 0; si < targetIds.length; si++) {
            selectedSet[String(targetIds[si])] = true;
            var sc = String(layerMeta[String(targetIds[si])].color);
            subjectCounts[sc] = (subjectCounts[sc] || 0) + 1;
        }
        for (var li = from; li <= len; li++) {
            var info = metadata.byIndex(li);
            preparationProgress(30 + 70 * (li - from + 1) / Math.max(1, len - from + 1), 100);
            if (info.section == 'layerSectionEnd') continue;
            var lid = info.id;
            if (selectedSet[String(lid)]) continue;
            var lc = info.color;
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
            fallbackFrameId = getBottomMostSelectedLayerId(targetIds, metadata);
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
        stackIndexOffset: metadata.backgroundOffset,
        startHistoryState: sourceDoc.activeHistoryState,
        targetIds: targetIds,
        subjectTargetIds: subjectTargetIds,
        layerMeta: layerMeta,
        tempFiles: tempFiles,
        items: [],
        analysisMap: {},
        subjects: [],
        frames: [],
        framesById: {},
        placementSolutions: null,
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
        text = L(str.prepareImages) + ': ' + (i + 1) + '/' + runCtx.subjectTargetIds.length + ' — ' + name;
    app.activeDocument = runCtx.sourceDoc;
    lr.selectLayer(id);
    if (!lr.getProperty('visible')) lr.setLayerVisiblity(id, true);
    runCtx.previewTouched = true;
    protectTemporarySmartObjectName(id, name);
    var preview = exportLayerPreview(runCtx.sourceDoc, id, i, runCtx.tempFiles);
    if (preview) runCtx.items.push(preview);
    app.changeProgressText(text);
    $.sleep(0);
}

function pythonAnalysisProgressChunk() {
    // app.doProgressTask() needs a globally visible work function. Calling it
    // repeatedly from the socket polling loop advances the current Photoshop
    // progress segment while Python is still working.
    app.changeProgressText(L(str.analyzePython));
    $.sleep(0);
}

function analyzePythonStage() {
    app.changeProgressText(L(str.analyzePython));
    // Large selections can legitimately take longer than the fixed base timeout.
    // Keep a generous per-image allowance while capping the wait at 15 minutes.
    var analyzeDelay = Math.max(ANALYZE_DELAY, Math.min(15 * 60 * 1000, runCtx.items.length * 10000)),
        analyzed = afApi.sendPayload('analyze', { items: runCtx.items, portraits: !!cfg.portraits }, analyzeDelay, true);
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
        text = L(str.detectBounds) + ': ' + (i + 1) + '/' + runCtx.subjectTargetIds.length + ' — ' + name;
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

        protectTemporarySmartObjectName(id, runCtx.layerMeta[String(id)].name);
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
    preparePortraitPlacements();
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
        text = L(str.detectBounds) + ': ' + (i + 1) + '/' + runCtx.subjectTargetIds.length + ' — ' + layerName;

    doc.selectLayer(id);
    // Read live bounds only after preview history has been restored.
    var descriptor = lr.getDescriptor(id), layerBounds;
    if (!descriptor.getBoolean(stringIDToTypeID('visible'))) {
        lr.setLayerVisiblity(id, true);
        // Visibility changes can affect group bounds: read them after the change.
        layerBounds = doc.descToObject(lr.getProperty('boundsNoEffects', false, id));
    } else {
        layerBounds = doc.descToObject(descriptor.getObjectValue(stringIDToTypeID('boundsNoEffects')));
    }
    descriptor = null;

    var subject = null;
    if (cfg.engine == 'python') {
        var analysis = runCtx.analysisMap[String(id)];
        if (!analysis) throw new Error('Python returned no result for layer: ' + layerName);
        if (!analysis.error && analysis.bbox && analysis.width && analysis.height) {
            subject = subjectFromLocalAnalysis(id, analysis, true, layerBounds);
        }
        // Detection failure is local to this photo. Use complete layer bounds for
        // this one subject, while all other photos keep the selected Python mode.
        if (!subject) {
            subject = subjectFromLayerBounds(id, layerBounds);
            if (!subject) throw new Error(L(str.errLayerBounds) + ': ' + layerName);
        }
    } else if (cfg.engine == 'device' || cfg.engine == 'cloud') {
        var measured = runCtx.analysisMap[String(id)];
        subject = subjectFromLocalAnalysis(id, measured, false, layerBounds);
        // Select Subject returning no usable object is also a per-layer fallback,
        // not a reason to switch or abort the complete batch.
        if (!subject) {
            subject = subjectFromLayerBounds(id, layerBounds);
            if (!subject) throw new Error(L(str.errLayerBounds) + ': ' + layerName);
        }
    } else {
        subject = subjectFromLayerBounds(id, layerBounds);
        if (!subject) throw new Error(L(str.errLayerBounds) + ': ' + layerName);
    }

    subject.color = meta ? meta.color : lr.getProperty('color')[1];
    subject.id = id;
    runCtx.subjects.push(subject);
    app.changeProgressText(text);
    $.sleep(0);
}

function subjectFromLocalAnalysis(id, analysis, fromPython, layerBounds) {
    try {
        if (!analysis || !analysis.bbox || !analysis.width || !analysis.height) return null;

        // Python previews and Photoshop Select Subject are both measured in the
        // temporary Smart Object's local coordinate system. Re-read live restored
        // layer bounds and map that local rectangle back to document coordinates.
        if (!layerBounds) layerBounds = doc.descToObject(lr.getProperty('boundsNoEffects', false, id));
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
        if (fromPython && cfg.portraits && Number(analysis.faces) == 1 && analysis.portrait) {
            var p = analysis.portrait, metricScale = Math.sqrt(sx * sy), metrics = [];
            for (var pi = 0; pi < p.metrics.length; pi++) metrics.push(Number(p.metrics[pi]) * metricScale);
            subject.portrait = {
                eye: [Number(layerBounds.left) + Number(p.eye[0]) * sx, Number(layerBounds.top) + Number(p.eye[1]) * sy],
                metrics: metrics,
                head_top: Number(layerBounds.top) + Number(p.head_top) * sy,
                head_left: Number(layerBounds.left) + Number(p.head_left) * sx,
                head_right: Number(layerBounds.left) + Number(p.head_right) * sx,
                chin: Number(layerBounds.top) + Number(p.chin) * sy
            };
        }
        subject.width = subject.right - subject.left;
        subject.height = subject.bottom - subject.top;
        // Relative source-edge distance, measured before Python's safety padding.
        if (fromPython && analysis.bottom_gap_ratio != undefined &&
            isFiniteNumber(Number(analysis.bottom_gap_ratio))) {
            subject.bottomGapRatio = Math.max(0, Number(analysis.bottom_gap_ratio));
        }
        if (!(subject.width > 1) || !(subject.height > 1)) return null;
        subject.center = { y: subject.top + subject.height / 2, x: subject.left + subject.width / 2 };
        subject.ratio = subject.width / subject.height;
        return finishSubjectGeometry(subject, layerBounds);
    } catch (e) {
        return null;
    }
}

function subjectFromLayerBounds(id, layerBounds) {
    var b = layerBounds || doc.descToObject(lr.getProperty('boundsNoEffects', false, id));
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

// Short-lived snapshot: never reused after layer transforms/reordering.
function LayerMetadataCache() {
    var ids = {}, indices = {}, bases = {}, self = this;
    function read(id, index) {
        var r = new ActionReference(), s2t = stringIDToTypeID;
        if (id != undefined) r.putIdentifier(s2t('layer'), id);
        else r.putIndex(s2t('layer'), index);
        var d = executeActionGet(r), section = typeIDToStringID(d.getEnumerationValue(s2t('layerSection')));
        var info = { section: section };
        // End markers are not real layers and must not enter the ID cache.
        if (section != 'layerSectionEnd') {
            info.id = d.getInteger(s2t('layerID'));
            info.name = d.getString(s2t('name'));
            info.color = typeIDToStringID(d.getEnumerationValue(s2t('color')));
            info.clipped = d.getBoolean(s2t('group'));
            info.index = d.getInteger(s2t('itemIndex')) - backgroundOffset;
            ids[String(info.id)] = info;
            indices[String(info.index)] = info;
        }
        if (index != undefined) indices[String(index)] = info;
        return info;
    }
    this.byId = function (id) { return ids[String(id)] || read(id); };
    this.byIndex = function (index) { return indices[String(index)] || read(undefined, index); };
    this.clippingBase = function (id) {
        var path = [], current = self.byId(id), base = null;
        while (current && current.clipped) {
            if (bases[String(current.id)] != undefined) { base = bases[String(current.id)]; break; }
            path.push(current.id);
            var index = current.index - 1;
            if (index < minimumIndex) break;
            current = self.byIndex(index);
            // Closing group markers have no selectable layer ID.
            while (current.section == 'layerSectionEnd' && --index >= minimumIndex) {
                current = self.byIndex(index);
            }
            if (current.section == 'layerSectionEnd') { current = null; break; }
        }
        if (current && !current.clipped && current.id != undefined) base = current.id;
        for (var i = 0; i < path.length; i++) bases[String(path[i])] = base;
        return base;
    };
    var backgroundOffset = doc.getProperty('hasBackgroundLayer') ? 1 : 0,
        minimumIndex = backgroundOffset ? 0 : 1;
    this.backgroundOffset = backgroundOffset;
}

function getBottomMostSelectedLayerId(ids, metadata) {
    // Photoshop itemIndex grows from the bottom of the layer stack upward
    // (background is 0/1 depending on document structure), so the smallest
    // itemIndex is the bottom-most selected layer.
    var bestId = null, bestIndex = Infinity;
    for (var i = 0; i < ids.length; i++) {
        var idx = metadata.byId(ids[i]).index;
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
        descriptor = lr.getDescriptor(id),
        frameName = descriptor.getString(stringIDToTypeID('name')),
        text = L(str.readFrames) + ': ' + (i + 1) + '/' + runCtx.frames.length + ' — ' + frameName;

    var maskKey = stringIDToTypeID('hasVectorMask'),
        emptyKey = stringIDToTypeID('vectorMaskEmpty'),
        useVectorMask = descriptor.getBoolean(maskKey) && descriptor.hasKey(emptyKey) && !descriptor.getBoolean(emptyKey);
    doc.makeSelection(id, useVectorMask);
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
    frame.color = typeIDToStringID(descriptor.getEnumerationValue(stringIDToTypeID('color')));
    frame.id = id;
    runCtx.frames[i] = frame;
    runCtx.framesById[String(frame.id)] = frame;
    app.changeProgressText(text);
    $.sleep(0);
}

function matchFramesStage() {
    app.changeProgressText(L(str.matchFrames));
    // Geometry and settings remain fixed from matching through alignment.
    runCtx.placementSolutions = {};
    if (runCtx.selectedFallback || runCtx.allClippedAtStart) {
        runCtx.assignments = null;
        return;
    }
    if (cfg.engine == 'python') {
        var matchSubjects = [], matchFrames = [], portraitCount = 0;
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
                bounds_only: !!runCtx.subjects[i].boundsOnly,
                placement_costs: placementCosts
            });
            if (cfg.portraits && runCtx.subjects[i].portrait && !usesLayerBoundsPlacement(runCtx.subjects[i])) {
                matchSubjects[matchSubjects.length - 1].portrait = runCtx.subjects[i].portrait;
                matchSubjects[matchSubjects.length - 1].layer = runCtx.subjects[i].layer;
                portraitCount++;
            }
        }
        for (var j = 0; j < runCtx.frames.length; j++) {
            matchFrames.push({ id: runCtx.frames[j].id, color: runCtx.frames[j].color, ratio: runCtx.frames[j].ratio, area: runCtx.frames[j].area });
            if (portraitCount) {
                var pf = matchFrames[matchFrames.length - 1], f = runCtx.frames[j];
                pf.left = f.left; pf.top = f.top; pf.width = f.width; pf.height = f.height;
                pf.portrait_top = cfg.portraitTop;
            }
        }
        var matchPayload = {
            subjects: matchSubjects,
            frames: matchFrames,
            use_face_count: !!cfg.useFaceCount
        };
        if (portraitCount) matchPayload.portrait_options = {size: cfg.portraitSize, auto_eye_line: true, bleed: FINAL_BLEED_PX};
        if (cfg.portraits && !portraitCount) runCtx.portraitSolutions = {};
        var matched = afApi.sendPayload('match', matchPayload, MATCH_DELAY);
        if (!matched || !matched.assignments) throw new Error('Python returned an invalid frame-matching response.');
        if (cfg.portraits && matched.portrait_layout) storePortraitPlacements(matched.portrait_layout);
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

function frameForSubject(subject) {
    if (runCtx.allClippedAtStart) {
        var meta = runCtx.layerMeta[String(subject.id)];
        return meta && meta.clippingBaseId ? runCtx.framesById[String(meta.clippingBaseId)] : null;
    }
    if (runCtx.selectedFallback) return runCtx.frames.length ? runCtx.frames[0] : null;
    return runCtx.assignments && runCtx.assignments[String(subject.id)] != undefined ?
        runCtx.framesById[String(runCtx.assignments[String(subject.id)])] : null;
}

function preparePortraitPlacements() {
    if (cfg.engine != 'python' || !cfg.portraits || runCtx.portraitSolutions) return;
    var items = [], i, subject, frame;
    runCtx.portraitSolutions = {};
    for (i = 0; i < runCtx.subjects.length; i++) {
        subject = runCtx.subjects[i]; frame = frameForSubject(subject);
        if (!frame || usesLayerBoundsPlacement(subject)) continue;
        if (!subject.portrait) continue;
        items.push({ id: subject.id, portrait: subject.portrait, layer: subject.layer,
            frame: {left: frame.left, top: frame.top, width: frame.width, height: frame.height},
            top: cfg.portraitTop });
    }
    if (items.length) {
        app.changeProgressText(L(str.portraitSolve));
        var result = afApi.sendPayload('portrait_layout', {items: items,
            size: cfg.portraitSize, auto_eye_line: true, bleed: FINAL_BLEED_PX}, MATCH_DELAY);
        storePortraitPlacements(result);
    }
}

function storePortraitPlacements(result) {
    if (!result || !result.solutions) throw new Error('Invalid portrait composition response.');
    runCtx.portraitSolutions = {};
    for (var i = 0; i < result.solutions.length; i++) {
        var solution = result.solutions[i];
        if (!isFiniteNumber(Number(solution.scale)) || !(Number(solution.scale) > 0) ||
            !isFiniteNumber(Number(solution.tx)) || !isFiniteNumber(Number(solution.ty))) throw new Error('Invalid portrait transform.');
        runCtx.portraitSolutions[String(solution.id)] = solution;
    }
}

function alignSubjectsStage() {
    var n = runCtx.subjects.length,
        slice = 1 / Math.max(1, n);
    for (var i = 0; i < n; i++) app.doProgressTask(slice, 'alignSubjectChunk(' + i + ');');
}

function alignSubjectChunk(i) {
    var subject = runCtx.subjects[i],
        layerName = runCtx.layerMeta[String(subject.id)].name,
        text = L(str.align) + ': ' + (i + 1) + '/' + runCtx.subjects.length + ' — ' + layerName,
        frame = null;

    if (runCtx.allClippedAtStart) {
        // Preserve the user's existing clipping structure. Each subject uses its
        // own real clipping-base frame; colors and global matching are irrelevant.
        var meta = runCtx.layerMeta[String(subject.id)],
            baseId = meta ? meta.clippingBaseId : null;
        frame = baseId ? runCtx.framesById[String(baseId)] : null;
        if (!frame) throw new Error('Cannot read clipping-base frame for layer: ' + layerName);
        lr.selectLayer(subject.id);
        if (usesLayerBoundsPlacement(subject)) alignLayerBounds(subject, frame); else alignLayer(subject, frame);
    } else {
        if (runCtx.selectedFallback) {
            frame = runCtx.frames.length ? runCtx.frames[0] : null;
        } else if (runCtx.assignments && runCtx.assignments[String(subject.id)] != undefined) {
            frame = runCtx.framesById[String(runCtx.assignments[String(subject.id)])];
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
    var offset = runCtx.stackIndexOffset,
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
    // The UI uses a convenient portrait range; the protocol can still replay
    // wider size ranges recorded by earlier releases without opening settings.
    cfg.portraitSize = Math.max(8, Math.min(40, Number(cfg.portraitSize) || 22));
    var dlg = new Window("dialog{orientation:'column',alignChildren:['fill','top'],spacing:10,margins:16}"),
        pnEngine = dlg.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:8,margins:10}"),
        dlEngine = pnEngine.add('dropdownlist'),
        chFaceCount = pnEngine.add('checkbox'),
        stDesc = pnEngine.add("statictext{properties:{multiline:true},preferredSize:[390,72]}"),
        pnMargins = dlg.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:6,margins:[10,18,10,10]}"),
        marginColumns = pnMargins.add("group{orientation:'row',alignChildren:['fill','top'],spacing:18}"),
        marginVertical = marginColumns.add("group{orientation:'column',alignChildren:['fill','top'],spacing:6}"),
        marginHorizontal = marginColumns.add("group{orientation:'column',alignChildren:['fill','top'],spacing:6}"),
        stVertical = marginVertical.add('statictext'),
        rowVT = addSliderRow(marginVertical, L(str.topOffset), 0, 20, cfg.vTop),
        rowVB = addSliderRow(marginVertical, L(str.bottomOffset), 0, 20, cfg.vBottom),
        rowVS = addSliderRow(marginVertical, L(str.sideOffset), 0, 20, cfg.vSide),
        stHorizontal = marginHorizontal.add('statictext'),
        rowHT = addSliderRow(marginHorizontal, L(str.topOffset), 0, 20, cfg.hTop),
        rowHB = addSliderRow(marginHorizontal, L(str.bottomOffset), 0, 20, cfg.hBottom),
        rowHS = addSliderRow(marginHorizontal, L(str.sideOffset), 0, 20, cfg.hSide),
        pnPortrait = dlg.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:6,margins:[10,18,10,10]}"),
        chPortrait = pnPortrait.add('checkbox'),
        portraitContent = pnPortrait.add("group{orientation:'row',alignChildren:['left','top'],spacing:12}"),
        portraitControls = portraitContent.add("group{orientation:'column',alignChildren:['fill','top'],spacing:6}"),
        rowPortraitSize = addSliderRow(portraitControls, L(str.portraitSize), 8, 40, cfg.portraitSize),
        sizeDirection = portraitControls.add('statictext', undefined, L(str.portraitDirection)),
        rowPortraitTop = addSliderRow(portraitControls, L(str.portraitTop), 0, 20, cfg.portraitTop),
        portraitDiagram = portraitContent.add('image'),
        portraitHelp = pnPortrait.add("statictext{properties:{multiline:true},preferredSize:[390,45]}"),
        buttons = dlg.add("group{orientation:'row',alignment:['center','top'],spacing:10}"),
        ok = buttons.add('button', undefined, actionMode ? L(str.save) : L(str.okButton));

    dlg.defaultElement = ok;
    ok.onClick = function () { dlg.close(1); };
    // Without a Cancel button, explicitly reserve Escape for cancellation;
    // it must never activate the sole/default Run button.
    dlg.addEventListener('keydown', function (event) {
        if (event.keyName == 'Escape' || event.keyName == 'Esc') {
            event.preventDefault();
            event.stopPropagation();
            dlg.close(2);
        }
    }, true);

    dlg.text = L(str.title) + ' ' + SCRIPT_VERSION;
    pnEngine.text = L(str.enginePanel);
    chFaceCount.text = L(str.useFaceCount);
    chFaceCount.value = !!cfg.useFaceCount;
    pnPortrait.text = L(str.portraitPanel);
    chPortrait.text = L(str.portraitEnable);
    chPortrait.value = !!cfg.portraits;
    portraitHelp.text = L(str.portraitHelp);
    rowPortraitSize.slider.preferredSize = rowPortraitTop.slider.preferredSize = [260, -1];
    var marginRows = [rowVT,rowVB,rowVS,rowHT,rowHB,rowHS];
    for (var mr = 0; mr < marginRows.length; mr++) marginRows[mr].slider.preferredSize = [185,-1];
    rowPortraitSize.helpTip = L(str.portraitSizeHelp);
    rowPortraitTop.helpTip = L(str.portraitTopHelp);
    portraitDiagram.preferredSize = [110, 150];
    portraitDiagram.helpTip = L(str.portraitPreviewHelp);
    var portraitPreviewState = { size: cfg.portraitSize, top: cfg.portraitTop };
    portraitDiagram.onDraw = function () {
        var g = this.graphics, w = Number(this.size[0]), h = Number(this.size[1]);
        if (!(w > 0) || !(h > 0)) return;
        g.newPath(); g.rectPath(0, 0, w, h);
        g.fillPath(g.newBrush(g.BrushType.SOLID_COLOR, [.94,.96,.96,1]));
        // The fixed image control is the viewport: native clipping crops the
        // larger bitmap. No file write, inference or full-dialog relayout.
        var pose = portraitPreviewPlacement(w, h, portraitPreviewState.size, portraitPreviewState.top);
        g.drawImage(getPortraitPreviewBitmap(), pose.x, pose.y, pose.width, pose.height);
        var pen = g.newPen(g.PenType.SOLID_COLOR, [.35,.48,.48,1], 1),
            blue = g.newPen(g.PenType.SOLID_COLOR, [.2,.6,.9,1], 1);
        g.newPath(); g.rectPath(.5, .5, w - 1, h - 1); g.strokePath(pen);
        var marginPen = g.newPen(g.PenType.SOLID_COLOR, [.3,.6,.4,1], 1),
            marginY = Math.max(.5, h * portraitPreviewState.top / 100);
        g.newPath(); g.moveTo(1, marginY); g.lineTo(w - 1, marginY); g.strokePath(marginPen);
        g.newPath(); g.moveTo(1, pose.eye); g.lineTo(w - 1, pose.eye); g.strokePath(blue);
    };
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
        pnPortrait.visible = pythonMode;
        if (pythonMode && !portraitDiagram.image) portraitDiagram.image = getPortraitPreviewBitmap();
        pnPortrait.enabled = pythonMode;
        rowPortraitSize.enabled = rowPortraitTop.enabled = portraitDiagram.enabled = pythonMode && !!cfg.portraits;
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

    chPortrait.onClick = function () { cfg.portraits = !!this.value; updateEngineUI(); };
    var lastPortraitDiagramState = cfg.portraitSize + ':' + cfg.portraitTop;
    function redrawPortraitDiagram() {
        var state = cfg.portraitSize + ':' + cfg.portraitTop;
        if (state == lastPortraitDiagramState || !portraitDiagram.visible) return;
        lastPortraitDiagramState = state;
        portraitPreviewState.size = cfg.portraitSize;
        portraitPreviewState.top = cfg.portraitTop;
        // Native ScriptUI images need their paint area invalidated. Restore
        // the exact viewport size before flushing paint events; no layout pass
        // or focus change is needed, and adjacent controls do not move.
        var bounds = portraitDiagram.size, width = Number(bounds[0]), height = Number(bounds[1]);
        portraitDiagram.size = [width + 1, height + 1];
        portraitDiagram.size = [width, height];
        try { dlg.update(); } catch (updateError) { }
    }
    bindSlider(rowPortraitSize, function (v) { cfg.portraitSize = v; }, redrawPortraitDiagram);
    bindSlider(rowPortraitTop, function (v) { cfg.portraitTop = v; }, redrawPortraitDiagram);
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

// Generated portrait preview: 160 x 240 px, 128 colors, alpha; 7 KB PNG.
// Crown (80,4), eye midpoint (80,32), chin (80,51) are measured once on
// this illustration. They are not inferred from the user's photos.
function getPortraitPreviewBitmap() {
    if (!getPortraitPreviewBitmap.image) {
        getPortraitPreviewBitmap.image = ScriptUI.newImage('\x89\x50\x4e\x47\x0d\x0a\x1a\x0a\x00\x00\x00\x0d\x49\x48\x44\x52\x00\x00\x00\xa0\x00\x00\x00\xf0\x08\x03\x00\x00\x00\xb0\x9f\x9f\xe8\x00\x00\x01\x80\x50\x4c\x54\x45\x23\x15\x1b\x5f\x2f\x1d\x1f\x1e\x1e\x23\x1b\x1b\x51\x2a\x1b\x51\x30\x22\x66\x5e\x54\xa5\x73\x5a\xda\x6b\x50\x4c\x2b\x1d\xa1\x62\x47\x8c\x4c\x33\x5b\x5b\x64\x23\x1d\x19\xa2\x53\x39\x1e\x59\x61\x87\x48\x30\xd4\x94\x71\x40\x86\x8e\xbc\x79\x37\x9f\x8a\x74\xd1\xa6\x8a\x05\x78\x78\x17\x41\x45\xff\xaa\x55\x16\x3d\x41\x7d\x43\x2e\xaa\x55\x55\xe3\xd4\xc7\x15\x3d\x41\x00\xff\xff\xff\xff\x00\xff\xd6\xb3\x3a\x41\x3b\x7f\x7f\x3f\x67\x44\x33\xff\x7f\x7f\xff\xff\x7f\x00\x00\x7f\x00\x00\xff\xff\xaa\xaa\x74\x43\x31\xb8\x82\x6b\xaa\xaa\xaa\xba\x94\x82\x00\x00\x00\x44\x47\x55\x37\x79\x81\x35\x76\x7d\xfc\xc2\x99\x2d\x68\x6f\x39\x3b\x48\x6c\x47\x34\xfa\xba\x92\x54\x37\x28\x3b\x42\x4e\x1b\x47\x4c\x23\x54\x5a\x27\x5c\x63\x39\x24\x1a\x28\x29\x33\xfe\xca\xa1\x3c\x81\x89\x2f\x32\x3c\x10\x28\x2c\x13\x35\x3a\x46\x2d\x20\xcb\x88\x67\xef\xa4\x78\x43\x29\x1d\x2d\x1a\x12\xee\xaa\x84\x02\x04\x07\xd6\x96\x73\x89\x59\x42\x00\x55\x55\x07\x08\x0d\x17\x3d\x41\x00\x3f\x3f\x7f\x00\x00\x61\x3e\x2d\xe8\x98\x70\x55\x55\x00\xaf\x66\x48\xca\x77\x55\xb4\x77\x58\xff\xff\xff\x7b\x51\x3c\x93\x65\x4e\x08\x09\x10\x17\x19\x22\x51\x34\x25\x0e\x13\x1a\x21\x23\x2d\x3a\x3a\x4a\x04\x17\x18\x1b\x1c\x25\xec\x88\x66\x0f\x34\x37\x19\x45\x4a\x7a\x3d\x3c\x87\x54\x3c\xb8\x84\x68\x11\x36\x3a\x06\x22\x24\x1e\x51\x57\xff\x00\x00\x11\x14\x1c\x55\x00\x00\xaa\x6a\x4d\xcc\x82\x5c\x09\x27\x2a\x55\x55\x55\x7f\x7f\x00\x39\x23\x17\x91\x54\x3a\xaa\xaa\x55\x07\x09\x11\x00\x00\x55\x0e\x16\x1a\x3a\x24\x18\x3f\x3f\x00\x39\x48\x53\x4d\x28\x1a\x13\x1d\x24\x42\x29\x1c\x8c\x49\x32\x98\x5c\x42\x22\xe3\xf1\xd3\x00\x00\x00\x80\x74\x52\x4e\x53\x1c\x5a\x9b\xd4\x25\xa0\xfd\xe5\xfd\xd8\xad\x96\x0c\x61\xed\xf4\x79\xf0\xfd\x03\xfd\xfd\x0a\xae\x03\xac\x6d\x03\xfd\xcb\x01\x01\xfd\xfd\x04\xf1\x02\x02\x02\x01\x03\xbd\xb2\x03\xfd\x00\xfd\xfd\xfd\xfd\xfd\xfc\xfc\xfd\xfc\xfc\xfb\xfc\xfd\xfc\xf7\xfd\xfc\xfd\xfc\xfd\xfb\xf9\xfd\xfb\xfc\xfd\x2d\xfd\xfc\x03\x4e\xfd\x04\x02\xfc\xfd\x03\xfb\xfb\xf8\x01\xfd\xfd\x6a\xad\xd1\x6e\xd9\x15\x4e\xca\xfd\x92\xd0\x04\xfc\xf9\xab\x55\xfd\x01\x8d\x03\xca\xf7\x71\x03\x02\x53\x93\x03\x8e\x03\xfa\x6f\x04\x16\x30\xf7\xab\xf9\xab\x73\xa2\x73\x8d\x00\x00\x19\x15\x49\x44\x41\x54\x78\xda\xed\x9d\x89\x5b\xdb\xd8\xb5\xc0\x65\x1b\x4c\x08\xd9\x27\xe9\xb4\xd3\x69\x3b\x6d\xa7\xcb\x5b\x84\x65\xed\x92\x65\x5b\xde\x97\x40\xc0\xb1\x09\x10\xc2\x24\x84\x40\xb6\x09\x59\xa6\x33\x49\x26\x4b\xff\xf5\x77\xce\xbd\x57\x9b\x6d\xd9\x42\x08\x93\xef\x7b\xbd\x09\x9b\x2d\xac\x9f\xce\x7e\xee\xbd\x16\x1c\xff\x85\x0f\xee\xff\x13\xe0\xfb\xdb\x7f\x82\xcf\xaf\x6e\x7f\x99\x80\x04\x8e\x8d\xb5\x2f\x0f\x10\xa5\xc6\xbd\xfb\xb4\xb8\xb3\xb3\x33\xff\xe6\xcb\x93\xe0\x8f\xf0\xf1\x6e\x47\x95\x65\x79\xf3\x60\x53\x96\xd5\xf9\x39\xfe\xd1\x9f\x5e\x71\x5f\x0c\xe0\x8f\x88\x87\x74\x9b\xb2\xba\xae\xae\xc3\x77\x3b\xc9\xa9\x3a\x91\xcb\xbc\x88\x78\x20\x39\x18\xf4\xf3\x7a\x6a\x7e\x67\x3e\xc5\xf1\xb7\xbf\x0c\xc0\xb4\xbc\x49\xf0\x64\x99\x71\x56\x09\xaa\xba\xf3\x21\x01\x42\xee\xe4\xea\xfd\x24\x1f\x00\xa1\x2a\x77\x37\x19\xa0\xac\x36\x80\x11\xbf\x4b\x9d\x9c\xf0\x84\x80\x60\x65\xa8\xde\x03\xd9\x13\x1f\x0a\xb0\x5a\xa0\xf2\xac\x9e\x9c\xf0\xc4\x2a\x5e\x94\xe5\x6e\x57\x95\x37\x19\x1e\xf9\xdc\xb0\x18\xa0\xac\x72\xcf\xd6\xce\x12\xf0\x35\xe1\xdb\x72\xa5\xc7\x38\x1b\x85\xaa\xfa\x57\x75\x7d\xb3\x2b\xcb\x9f\x4e\x2a\xc2\x13\x01\xbe\x07\xfb\x93\x0f\x40\x7e\x5d\x9f\xf8\x0a\x0d\x57\xc3\xf0\xb0\x7a\xf1\x84\x84\x27\x01\xbc\xcd\xa7\x28\x45\xf7\x00\xdc\x64\x9d\x30\x35\x9b\x8d\x42\x53\xa5\x80\x5d\x14\xe8\x22\xff\xec\xcc\x00\x9f\x71\x84\x69\xbd\x7b\xd0\x05\x6d\x92\xef\x0b\xcd\x42\xa1\x51\x40\x3e\x55\xdd\x04\xdb\x04\xef\x7e\x03\x82\x3e\x1b\xc0\xdb\xfc\x27\x12\x4b\x36\x81\x64\x4b\xae\x42\x26\xc9\x16\x0a\x48\xd8\x24\x01\x5b\x56\xbb\xa8\x79\x75\x11\x2c\xf5\x4c\x00\xd7\x78\xae\x4a\xa2\xde\x26\x2a\x53\xed\x1e\xc8\x5b\x6a\x41\xde\xdc\xda\xda\xea\xae\x37\x54\x62\x97\x44\xac\x0d\x8e\xe4\xea\xd9\x03\xfe\xc8\xa7\xd7\xd7\x65\x16\x00\x55\x79\x0b\xe4\x75\xd0\x6b\xe5\xf3\x79\x25\x7f\xf5\xa0\x50\x90\xb7\xb6\x58\xd4\x4e\x9f\x48\xc7\x27\xb1\x41\x15\x4f\xcf\x02\x0c\x86\x14\xb9\xae\xe4\xc9\x28\x2a\x5d\x15\x15\x4c\x32\xb3\x9c\xe1\xce\x44\xc5\xaf\xf8\x79\x02\x40\xdc\x44\x25\xc9\x78\x83\xf1\xa1\x14\xbb\xd4\x0c\x89\x08\x4f\xa4\xe3\xf8\x57\x37\x47\x0a\x02\x22\xc0\x2a\x0d\xd4\xad\xbc\x37\x3a\x72\x81\x02\xc2\x47\xea\x24\x3a\xe6\x62\xbb\xf0\x3c\x89\x25\x6e\x84\x56\xe5\x9a\x8f\x2f\xaf\xf4\xd7\x19\xa1\xaa\xee\xdc\x79\x3d\x73\xc0\xdb\xfc\x5c\xd5\x51\x30\xe5\x53\xfb\x8a\x1f\x30\xdf\xf9\x4c\x8b\x43\xf8\x80\x92\x81\x9b\x35\xe0\xda\x6f\xe7\x0b\xaa\x83\x86\x9f\xaa\x72\x2f\x20\x40\x25\xdf\x39\x68\x50\x19\xaf\x57\x17\xe7\xe2\x17\xd7\x5c\x4c\x01\xa6\x0a\x4c\x80\x55\x6a\x86\x07\x47\x7e\xbe\x22\x8e\x3e\xa6\x14\x24\x54\x33\xa9\xb9\xd9\x4a\x70\x8d\x9f\x9b\xc7\x10\xb8\x2e\xd3\xc2\x14\x48\x0f\x3a\x4a\xbe\xe8\xe0\x29\x37\x0e\xb7\x36\x14\x05\xea\x86\x02\x91\x70\xe3\x4d\x8a\x5b\x9b\xad\x8a\xe7\xa9\x6e\xd5\x2a\x2b\x60\xb0\xc8\x97\x0f\x29\x5f\x6b\x0b\x7e\x80\x8c\xd2\xe9\x37\x55\x24\x84\x6b\x48\x7f\x48\xcd\x52\x82\xaf\x31\x04\xae\x93\xd2\x99\xd6\xa7\xf2\x41\x1d\x84\xd6\xdd\xec\x10\xc0\x85\xee\xe1\x0d\x10\x67\xf1\x6a\xad\x59\x68\x34\x1b\x9b\x78\x25\x6f\xe6\x3e\xcc\x0e\x10\x23\x4c\x03\x95\xeb\x64\x11\xb9\xbf\xd7\xeb\xb4\x14\x1c\x90\xe7\xc0\x41\x94\x7a\xad\xd6\x52\xf2\x75\xb5\x09\x83\xfa\x32\x97\x8a\x59\x76\x71\x71\x1c\x64\x3e\xad\xae\x17\xdc\x2e\xa4\x2a\x1f\x1d\x34\x9b\x05\xb5\xdf\x6a\x21\xa0\xa2\xf4\xb2\x16\x94\x85\xfd\xba\x22\xab\x7b\x9f\x9b\x05\xb0\xd6\x86\xba\xf3\xe6\xd1\x8c\x24\x88\x0e\xc2\xef\xa8\x0e\x1f\x56\xcf\x03\x35\x93\x2d\x80\xa8\x3a\x44\x84\x8a\xb2\xf0\xd6\x6a\x2e\x2c\x67\x36\xf2\x72\x7f\xe1\x1c\x31\x43\x48\x2b\xf3\x1f\xe2\x85\x9a\xe3\x03\xde\x9e\x9f\x7b\x03\x2a\xa6\x78\xd0\x7d\x34\x2e\xd5\x6b\x9f\xbf\x5d\x68\xaa\xdf\xfe\x2f\x05\x6c\xdd\xb8\xbe\xb8\xf8\xed\x61\x5f\x51\xe4\xfe\x60\xd0\x50\x0b\xe0\x49\xd5\xc5\xb8\xb5\xff\xf1\x55\x3c\x97\xe2\xd3\x2c\x05\x17\x30\xd0\x35\xa0\x46\x68\x2d\x1c\xf6\x3b\x45\x85\x49\xb0\xa8\xd4\x0e\x6b\x35\xf8\xee\xf3\x40\x39\x6a\x56\x89\xb4\xd3\x6a\xcc\x74\xc2\x1d\x5f\xc3\x73\x7c\x83\xea\xb6\x09\xa9\xa2\x70\xe9\x73\x1f\xc1\xea\x0c\x0e\x73\x08\x31\x44\x18\xad\x85\x41\x7d\x40\x0e\x82\xee\x6e\x71\x7e\x56\x80\x1f\xe6\xde\x21\x5f\x13\x3b\x0f\xb5\xf1\xf9\x5c\x9f\x00\x06\x06\xe5\x53\x7a\x83\x5a\x6b\xab\x59\x00\x43\xa8\x66\x77\x3e\xcd\x08\x10\x54\xfc\x0e\x02\x74\xa1\x50\x6d\x56\x21\x7c\x34\xfb\x57\x2f\x5d\x6a\x29\xe3\x47\xad\xdf\x6b\x81\x19\xfc\x95\x88\xb0\x90\x9a\x91\x0d\xbe\xe7\x41\x80\x20\x3d\xea\x9c\x4d\x75\x6f\xaf\xdf\x1a\x15\x1e\x05\xec\x29\xdd\x66\xb5\x20\xaf\xcb\x85\xea\x66\x63\x6e\x46\x61\xe6\x02\xa4\x91\x46\x13\x2c\x90\xe8\xb9\xd1\x3c\x50\x7a\x35\x17\xae\x05\x0e\xd2\x72\x20\x5b\xb5\xef\x6a\xcd\x06\x01\xac\x16\x36\xe7\xe1\x37\x67\x94\x49\x76\xe4\x0c\xf5\x4c\xb9\x01\xd5\x40\xf3\xb0\xb5\xe1\x02\xd6\x06\x4a\xad\xe6\x02\x6e\x74\x20\x0a\x55\xab\xf2\xfa\x3a\xe8\x78\x87\xbf\x33\x33\x40\x15\x13\x09\x69\xd3\xb1\x0d\x86\x1c\x92\x77\xb4\x9b\x6f\xf5\x5a\x8e\x9e\xf3\x1d\x48\x2f\xc0\xa7\x62\xcf\x52\x50\x67\x0a\x78\x11\xea\x04\x50\x9c\x8c\xae\x82\x90\x37\x68\x08\x2c\xc2\x3f\xf2\x99\xf0\x16\xc1\x81\x0b\x55\xb5\x41\xea\xd9\x8c\x3a\x0f\x6d\xd6\x4c\x00\x39\x28\x15\xda\x3b\x55\xf5\x00\x7b\xf2\x02\x46\x9b\x46\x73\xab\x48\xf4\x5b\xdb\xdb\xdb\x3b\x77\x0e\x3e\xa8\x96\xc1\xd5\x01\x90\xd8\x6a\x35\x76\x9c\x3e\xfe\x6f\xfd\xc8\x7f\x50\x39\x68\x98\x36\xb1\x1c\x6c\xe0\x4c\x1b\x88\xb0\x85\x55\x4c\x1e\xe8\xc8\xe8\x41\xe5\xaa\x14\x37\xc0\x81\x0b\x8e\x00\xe7\xd5\xb8\x5d\xc9\xf1\x7f\xef\x35\xff\xe9\x13\xbf\xa8\xca\xe8\x26\x10\x84\x11\xa3\x29\xd3\x62\xba\x77\x6e\xaf\xb7\x77\xae\x8e\x3d\x49\xb1\x05\x06\x08\xa1\xbc\x81\x85\x77\xe1\xe2\x4e\xec\xa9\xd6\x18\x17\xb6\xc6\xbf\x7b\xd3\xae\xca\x0d\x38\x37\x40\x92\xd9\x2c\x50\x32\x21\xac\xef\xed\xb1\xd9\x0f\x05\x95\x5f\xc0\x45\x09\x88\xe7\xf7\xdf\xcd\xc7\xee\xdd\xe3\x49\xfe\xc3\xab\x77\x90\x4d\xa0\x25\x21\x84\x55\xf0\x95\x2e\xa1\xca\xe7\x69\xef\x59\x6c\xad\x17\xb0\x92\x00\xbe\x46\x55\x4e\xcf\x9d\x60\xf1\x29\xa6\x69\x3c\xe3\x91\x0c\x95\x0c\x0a\x44\x33\x5c\x1c\x28\x45\xaf\xa9\xeb\x0c\x1a\xe8\x20\x30\x0a\x19\x79\xf1\x2c\x26\x8f\x7e\xe4\xdf\x80\xe9\x37\x88\x0c\xb1\x67\x2a\xa8\xbd\x41\xa7\x58\x24\xb5\x0c\x54\x5b\x47\xbd\x2a\x52\x37\xd4\xc6\xc5\x1d\x74\x8f\xb5\x99\x03\x22\xa1\xba\x98\x86\x52\x0a\xbc\xa4\x81\xda\xec\xd5\x8f\x40\x88\x30\xf2\x57\x37\x6a\xf5\x1e\x79\x4c\x2d\x5c\x4c\xcf\x9f\x6c\x7a\x30\xfe\x9c\x04\x08\xe5\xdd\x1b\x2e\xbd\xa8\xaa\x99\x74\x26\x93\x5e\xec\xd5\xeb\xbd\xc1\x51\xad\x53\xdb\x18\xc0\xb7\xf5\xc5\xf4\xa7\x9d\xf9\x34\xc7\x9d\x78\x99\x23\xfe\x0b\x60\xd8\x80\x0a\xe5\xcd\xbb\x14\x07\x35\xec\x95\x3a\x8e\xde\xd1\xe0\x08\xf1\xf2\xca\x15\x7e\xce\xb1\xd6\xb3\x5b\x86\x78\xcf\x7b\xda\x5b\x82\xa2\xda\x1d\x60\x88\x3f\x81\x84\x5f\xbd\xe7\x4f\x3e\x4e\xac\x82\x1f\xdf\xbf\x5f\xe3\xbf\xe2\xcf\x43\x84\xf1\xf1\xe5\x5f\xf0\xff\xe4\x13\x19\xc9\x2c\x68\xdf\xe1\x8e\x48\x10\x74\xf0\x94\x62\x67\x8e\x7f\xc4\xdf\xfc\x12\x00\x11\xe2\x0e\x68\x98\x84\x68\x52\xd4\xd0\xf1\xc2\x7b\xfa\x4c\x01\xa1\x4c\xe6\x7e\xe5\x53\x9d\x7c\x70\xfa\x12\x58\x5f\x70\xdc\x6f\xe0\xd5\xef\xdc\x3c\x43\xc0\x5f\xe0\xe4\x4f\x2e\xeb\xf6\x5f\x5b\xc5\x61\x3e\x88\xd7\x47\xea\xea\xd3\xcb\x4f\x00\xf1\xd6\xd9\x00\xde\x44\xd1\xb4\xbf\x16\x73\x7f\x3e\xcc\x8f\x1f\xca\x86\x96\x13\xf7\x9f\xe0\xc1\xb7\x6e\xce\x16\xf0\xe6\x2d\x52\xbf\xdf\x7f\x6c\x0a\xa2\x98\xfd\x2e\xaf\x8c\xe5\x2b\x2a\x66\x4e\x14\xc4\xfd\x8b\x6d\x3c\xf8\x4e\x3c\xc8\x18\x80\xb7\x68\xed\xfe\xe4\xe1\xbe\x28\xe6\x04\x51\xb8\x7c\xbd\x38\x0e\x10\x1e\xcb\x0a\xf0\x34\x0c\x73\xff\xe1\x13\x4f\xea\xa7\x0c\x48\x4e\x71\xf1\xe1\xd7\x86\x98\x2b\x95\x04\x44\xcc\x19\x6e\xdf\xe9\xcc\xa0\xd3\x91\xbd\x2c\xe4\x10\x31\x97\x83\xeb\x30\x18\xe4\xcd\xd3\x97\xe0\x4b\x80\x13\x80\x0e\xce\x9b\x23\x02\x12\x8d\xeb\xc5\xbc\x47\x48\xe9\x8a\x4a\x56\x24\x02\x84\x4b\x40\x44\x38\x5e\x34\xbe\x06\xc6\x3f\x9e\x26\x20\x5c\xfe\x43\x10\x9d\x37\x04\xa2\xe4\x9c\x99\xbd\x51\x2c\x92\xc5\x07\x3a\x7b\x04\x25\xd7\x75\x43\x2c\xc1\x33\x22\x5e\x02\x1e\x88\x47\x03\xe3\xfe\xcb\xd3\x94\xe0\x2f\xfc\xfd\x7d\x01\x24\x47\xcf\xc9\x08\x09\xc1\x65\x33\x7b\x5d\xa1\xab\x0f\x58\x15\xde\x58\xc8\x5e\x46\xc1\xe1\xb3\x39\xef\x60\x64\x14\x1f\x9f\x1e\xe0\x4d\xfe\x89\x51\xa2\x58\xde\x19\x01\x01\xff\xe5\x44\xd3\xcc\x66\xb3\xd7\xaf\x5f\x5f\xc8\x66\x45\xf3\x32\x3c\x81\xd7\x81\x7c\xee\xb5\x50\xc2\xdc\x1f\x8e\x65\x87\xc7\x92\x60\x5b\x2f\x09\xc3\x80\x44\x4a\x62\x0e\x5d\x01\xbe\x23\x03\xd8\x18\x5e\xc0\x1a\x9c\x2f\x42\xfa\x38\x84\xc7\x00\xfc\x0d\xff\xd8\x3d\x17\xaa\x4d\x70\x4e\x2a\xa2\x9a\x73\xec\x9f\x70\x8d\x3c\x2b\x10\xd9\x06\x2f\x85\xfd\x72\xc9\xe0\x4e\x45\x82\x37\xf9\xfb\x26\x3b\x1f\x05\xf0\x4c\x11\x45\x27\x80\x4f\x50\x72\xe2\xb6\x44\x92\xb9\x71\x80\x30\x1e\x1f\x43\x84\xd1\x01\x5f\xb9\x02\x74\x4e\xec\xb3\x7e\x81\xa8\x97\x44\x15\xaa\x68\xc1\x7d\x22\x28\x3e\x42\x6d\x9c\x92\x0d\x12\x0f\x71\xed\x4a\xa0\x12\x14\x5c\x39\x09\x8e\x0d\x06\xc0\x3d\xe3\x13\xdc\xdf\x16\x2f\xf2\xb7\x12\x07\xbc\xc5\xdf\x17\x3d\x40\xc1\x31\xc4\x10\x25\xba\x7c\x2e\x20\xe5\x33\xc5\xe3\xea\x98\x8b\x6e\x82\x0f\xa9\x47\xe0\x39\x50\x53\x9e\x05\x4e\xe6\xf3\x1b\x85\x49\x52\x63\xae\xa4\x9f\x8a\x8a\xf7\x99\x15\x19\xcc\x94\xbc\x0c\x11\x0a\x98\xf3\x0e\x21\xb2\x34\x44\x12\x7e\x72\xc7\xf0\xe3\x63\x00\x1a\x0e\xa0\xc8\x6c\x9d\xc9\x48\x18\x13\x4a\x84\xd1\xf8\x07\xc5\x85\x68\x30\x1b\x34\x5e\x46\x36\xc2\xe8\x80\xf7\x5d\x40\xc3\xe7\x29\x8e\x91\x09\xb9\x29\xfa\x86\x5f\x29\x19\x26\x7a\x77\x09\xac\xe4\x61\x64\x23\xe4\x22\xfb\xc8\x4b\x66\xe0\xa2\xa9\xc3\x07\x73\x14\xd7\x4f\x04\xc7\x93\x05\x61\xd8\xf8\xbc\x00\xa3\x93\x97\xc0\x18\xb4\x1f\x79\xc6\x9a\x8b\x9e\x46\x04\xe2\x1a\xf0\xfa\x3a\xb5\xc3\x51\x13\x14\x1c\xe0\x71\x80\x50\x5d\xeb\x28\x79\x92\x0a\x8d\x53\xb0\xc1\x7d\x2c\x4e\x48\xf9\xa7\x41\x61\x30\x4e\x48\x6e\xd4\x13\xc6\x10\xc2\x35\x99\x3a\xa9\xbf\xb0\x8a\x34\xdb\x89\x03\xb6\x35\x94\x9f\x89\x39\xd6\x40\x55\xf9\x4b\xae\x11\xd3\x13\x46\x52\x08\x78\x70\x4e\x07\xf7\x22\xd6\x0b\x5f\x9e\x44\xf5\x12\x2e\x7a\x22\xa6\x05\x0b\x01\x34\xc4\x71\x0c\x41\x5d\x0f\x89\x11\x42\xcc\xaa\x49\xeb\x1b\xac\x72\x1f\x26\x0c\x08\x3e\x42\xf3\x2b\x98\x92\x60\xac\xea\x53\xc2\x5f\xce\xe3\x73\x8f\x34\x8c\x55\x51\x34\x98\x43\x47\xcf\x25\x91\x25\xf8\x58\xa0\xd5\x13\x31\x76\x5b\x18\x97\x31\x04\xbf\xae\x87\x85\x58\x32\x74\x1d\x8c\xd0\x01\xdc\x8f\xda\x9b\x44\x04\xfc\x23\xe4\x11\x91\x6a\x15\xa2\xad\x6e\x0f\xc5\x61\x61\x4c\xe5\x12\x04\x84\xdf\xab\xe8\x86\x49\x3b\x3c\x68\xb9\xf6\x13\x77\x12\xdd\x01\x44\x1b\xac\x94\x46\xbd\x62\x38\xe8\x08\x43\xce\x2c\x56\x2a\xc4\x8c\xa9\x9f\xe8\x49\x03\xb6\x8d\x92\x48\xab\x04\xe8\xe1\x56\xf5\x61\x40\xbf\x6a\x83\x96\xe8\x1d\x61\xaf\xb2\x44\x87\x41\xdd\x68\x27\x0d\x28\x96\x68\x84\x40\x11\xea\xa3\x80\x3e\xa6\x51\x68\x3a\x6c\x13\xa3\x13\x4b\x93\x09\x03\xde\xe2\x9f\x88\x25\x41\x64\xfa\x01\x1d\x97\xc2\x05\x18\xe6\xe0\x02\x00\x0a\x0c\x10\x3e\x73\x09\x03\xbe\x44\xc9\x31\x0b\x17\x8c\x61\x1b\xf4\x39\x83\xe0\x6b\xab\x86\x24\xf8\xd4\x14\xe8\x0b\xe0\x85\xde\x8f\x18\x67\xa2\x02\x3e\x14\xa8\x7a\x51\x00\x04\x30\x00\x20\xd0\xae\xce\x8d\x7d\x82\xd3\x10\xf8\x5b\x76\x5b\xf7\x34\x1c\x3d\x95\x44\x06\xf4\x77\x15\x46\x25\x27\x0c\xb9\xac\xe0\x36\x52\x81\x30\x1d\x90\xa0\x4e\xbc\x8c\x02\x0a\x2f\x13\x05\xbc\xc9\xff\xce\x6d\xe5\xc0\xd2\xcd\xca\xb8\xec\x1b\xa8\xb6\x46\x09\x05\x5b\x77\x9a\xe5\xe4\x01\x5f\x51\x40\x77\xae\xc3\x16\x27\xa4\xb9\xb1\xa9\x18\x7e\xcf\x46\x1f\x61\x45\x25\x4e\x2f\x24\x0b\xf8\xb5\x77\x22\x08\xb7\x15\xa3\x24\x78\x4d\xc7\x48\xbd\x25\x8c\x21\x2c\x19\x36\x9d\xec\x3a\x15\xc0\x9b\x3e\x09\x82\x10\x44\x48\x25\x2c\xa9\x0a\xfe\x62\xcb\x0b\xd2\x8e\x29\xfa\x1e\xac\xac\x8a\xa4\x25\x64\x17\xf5\x30\x61\x40\xdf\xac\x02\x9c\xc5\xb4\x45\x17\x70\x44\x8c\x43\x2d\x33\x9b\xe1\x12\x6d\xac\x06\x4d\xd7\xbb\x1f\x9f\x42\x98\xf1\xdc\x04\x12\xbf\x90\xf3\xe4\x11\x48\x1e\x82\xa7\x7a\x67\x6e\x09\x1f\xd5\x6d\x51\xa4\x7d\x3b\x25\x7c\x0c\x5d\x44\xd2\x81\xda\x51\x17\x9c\x47\xc3\xd3\x51\xc0\x60\x98\x66\xba\x75\xda\x3d\x36\x9d\x00\xc1\x05\x34\x2c\xfa\x34\x9c\xfb\x43\xc4\xad\x52\xd1\x53\x9d\x6f\x02\x03\xda\x47\x08\x6a\xa2\x48\x0b\x6b\x7f\xa2\x0b\xf8\x07\xfb\x00\x2c\x40\xfb\x68\xd0\x69\x1b\x27\x62\xee\x27\x9a\xea\x7e\x61\x13\x33\x8c\x04\xb2\xfe\x2a\x8a\x50\x1f\xea\x46\x84\xa1\xc1\xca\x7b\x03\xdd\xca\xa6\x73\x9b\xee\x6f\xe8\x49\x57\x33\x46\xa0\x43\x13\xf5\xb7\x26\x36\xc8\xa3\x95\xf5\x10\x22\x99\x62\x87\x0b\xb2\x6d\x14\x24\x49\x81\xc4\x0e\x23\x97\x33\x91\x0b\x56\xc3\x5f\x94\x9a\xa6\xf1\x56\x17\x35\x73\x18\x70\x58\x8c\xd4\x87\xe1\x7a\x8c\x8f\x15\xd1\x5f\x6d\x45\x4f\x25\xc7\x96\x20\x51\x13\x58\xa1\x5d\x11\x75\x71\x5c\x9c\x1e\x0a\xd2\x78\xbc\x0e\x1a\xd6\x45\x52\x4f\xbb\x91\xba\xa4\x47\x9b\x5c\x88\x0a\xe8\x4e\xff\xd2\xa9\x5d\xc3\xa8\x54\x74\x7d\xb4\x09\x19\x07\x08\xea\x84\x26\x41\x27\x2e\xec\x4d\xbd\x96\x40\x84\x37\x13\x0c\xd4\x0f\xdd\x08\x4b\x82\x19\xe4\x12\xbd\x62\x04\x96\x18\x1c\xa3\x0b\x9a\x20\x39\x5c\x5c\x7d\x4a\x00\x45\xd3\xf4\x2e\x29\xe2\x24\x61\x34\xc0\x67\xbc\x5e\x72\x85\x82\x93\x68\xa2\x61\x6b\x15\x71\xb4\xb6\x1f\xf6\x62\xb6\x96\x53\xa1\x80\xa6\x21\x78\x0d\x60\x09\x6a\xd6\x5b\x09\x01\xde\xe2\xd3\xfe\x1e\x0d\xe3\xa0\x69\xaf\xea\x53\x66\x15\x1c\x89\x8b\x22\xf4\xc4\x18\xa7\x69\xd7\x99\x43\x41\x92\x19\xf7\x27\x89\x01\x42\xd3\x59\x0a\xce\xb3\x18\x66\xc5\x36\x4b\xd3\x00\x73\x74\xb9\x04\x6c\xaf\x52\xa9\x18\x3a\x99\xb3\x83\x8e\x0b\x07\x68\x41\x6f\x27\xe8\x24\xc6\x35\x9c\xc4\x37\x5d\x1b\x37\x56\x6d\x5b\x08\x9d\xf7\xf5\x99\x20\x5d\x44\xc9\x01\x20\xb1\x08\x91\xa0\x81\x0c\x75\x53\x4c\x27\xe7\x24\x77\xf8\x3f\x94\x04\x43\x5f\x5d\xc5\xff\x74\x76\xc0\xfc\xa8\x85\xb5\x9e\x41\x01\x52\x11\x8a\x6f\x91\x0f\x5e\x83\x4d\x6e\x43\x76\xd9\xe7\x92\x0c\xd4\x2b\xba\xf8\x54\x47\xcb\x81\x88\x01\x32\xc0\xe4\x2f\x86\x4d\xf7\x0e\xd9\x20\x15\xa1\xad\x61\x6a\x34\x44\x67\xe8\xf6\xbd\x64\x33\xc9\x7d\x5b\x7f\x4a\x52\x15\xaa\x07\x4e\xa4\xad\x96\x42\x56\x21\x86\xc2\x0c\x13\x21\xf8\xbc\xa9\x19\x9a\x66\xd0\x75\x1e\xb4\x97\x97\x91\x0a\xae\xa8\x80\xbf\x73\x23\x18\xbc\x34\x58\x50\x45\x2c\x09\xb9\xa9\x46\xc8\xea\x56\x14\x99\x8d\xb2\xa7\x93\xe8\x74\xb1\x3e\xe2\x9a\x62\xc4\x30\xc3\x8a\x19\x27\x54\x43\xd4\x28\x8d\x5b\x8a\x1b\x96\xa3\x6f\x39\xb4\x62\x57\x0c\x0f\x57\x4c\x36\x0e\xc2\x61\x1a\x3a\x06\x86\x07\x88\x81\xf0\xda\x34\xc6\x04\x17\x84\x43\x96\x99\xf0\x0b\xa9\xb7\xd8\xf4\x31\x1b\xa2\xa0\x27\x6a\x83\xcf\x75\xf4\x0e\xe2\x26\x60\x81\x66\x85\xad\x5f\x4f\x99\x68\x75\xba\x13\xac\x67\x48\x01\xa9\x6b\xae\x1d\xeb\xf7\x92\x03\xfc\x0d\xff\x50\x24\x0b\xe8\x60\x7e\x26\xda\x52\xc5\x2c\x09\xd3\xf8\x02\xed\x13\x96\x3f\xa6\x51\xd1\x89\x7a\x49\x22\x31\xf5\xfb\x09\x4a\xb0\x2d\x5e\xf3\x6f\x01\x58\xb5\x4b\xee\x8a\xf5\x54\x44\x4a\x88\x97\x05\x31\xd4\x30\x68\xac\x07\x47\xb9\x96\xa4\x8a\x39\xf3\x9a\x20\x7a\xfe\xa0\x6b\xd7\x7c\x6b\xd6\x53\x01\x29\x21\x94\x84\x3a\xb8\x49\x89\x7a\x09\x3a\x49\x3b\x41\x15\x3f\xc6\x02\xc1\x60\x4e\x22\x56\x84\x30\xf7\x1d\xbb\xbc\x43\xbf\x3c\xfd\x48\xd2\x08\x84\x7a\x18\x18\xec\x13\x75\x92\x76\x85\x2d\xf5\x9b\xc4\x0d\x4b\xe3\xe1\x26\x8b\xd5\xd6\x21\x84\x1a\x4f\x69\x2e\x86\xae\xe6\x5e\x82\x05\x6b\x9b\xec\xe7\xc9\xd1\xd0\x62\x56\x2a\xa5\x71\x6c\xd3\xb4\x0e\xb1\x09\xcc\x90\x84\x02\xb2\xb8\x9d\x4e\x4c\x82\x38\x3b\x58\xca\x95\xdc\x5a\xdd\x0c\x16\x32\xce\x56\x85\x69\x46\x59\xd2\x6c\xd4\xac\x5b\xf3\x8b\xf7\xa2\x9c\x9d\x8b\x54\xcc\xec\x97\x04\x1a\x62\x49\x2e\x85\x7a\xdf\x0f\x23\x0c\x6d\xa4\x08\x53\x3e\x84\x77\xba\x50\xe0\x5c\x4c\xa4\xe9\x99\x28\x80\xb8\x21\x45\xc4\xd8\x4f\x8b\x19\x08\x66\xb6\x5d\xd1\xcd\x48\x51\xc6\x2f\x61\x13\x63\xb5\xa6\xeb\x4f\x9f\x92\x8a\x35\xda\x0e\xa4\x88\x61\x06\x4a\x19\xda\x02\x91\x64\x65\x40\x57\xac\xaf\x56\x20\x2d\x88\x53\x83\x0c\x63\x43\xd7\xa8\x54\x48\x21\x44\x96\x74\xf1\x52\x57\x12\xf4\xe2\xfb\xab\xe4\x65\x71\x93\x16\x66\xac\x0a\x8a\xd3\x24\x90\x46\x50\xbd\xec\x30\x7c\xd0\x15\x1c\x94\xba\xd0\xa4\x6a\x06\xb4\x31\x22\xdb\x72\x26\x96\x4a\x7a\x9a\xff\x7b\x62\x80\x50\x52\xd3\x33\x0b\xb8\x18\x6d\x1a\x36\x5d\x3a\x27\x90\x90\xf8\x56\xf1\xf3\x53\x5a\x07\xac\xd2\x5a\xe0\xa9\x41\x07\x7b\x44\x33\x75\xfb\x2d\x99\x70\xc2\x75\x7b\xb2\xfd\x4c\x4b\xb6\x60\xd5\x05\xb6\x1f\x15\xb5\xb3\x0a\x81\x10\x4f\x22\x90\x1d\x98\x22\x86\x70\xa4\x80\x18\x67\xe0\x6a\x37\xab\x58\xb0\xb5\x87\x41\x32\x2f\x69\x54\x2b\x50\x65\x90\xbd\x5d\x44\x8c\x11\x27\x67\xa2\x06\x6a\x23\x47\x35\x4c\x00\x6d\xb2\xac\x4f\x6d\x12\x3f\x4a\x74\x3b\x1e\x9d\xfb\x23\xc7\xe4\x44\x67\x33\x97\x48\x37\xc7\x61\x06\xc7\xde\xd8\x03\x34\x93\x2c\x16\xf8\x15\x23\xc7\x74\x83\x80\x15\x93\xac\xeb\x93\xc4\x46\xa9\xc9\x33\x04\x86\x3c\xc0\x7e\xa2\x3b\xe1\x48\x50\x11\x89\x93\x04\x00\x9f\x24\x97\x49\x6e\xf1\x4f\xc8\x2b\x97\x88\x14\xc1\x04\x6d\x09\x54\x4e\xe5\xe6\x28\xda\x05\xa4\x64\xec\x71\x91\x6d\xc3\x25\x3f\x40\x2b\x4d\xe9\xa9\xa9\x44\x9b\xde\x8a\x08\x78\x11\x05\x71\x99\xc9\x42\xb7\x97\x25\xcb\x5e\x35\x00\xb8\x44\x15\x2d\xb0\x0d\xc1\x64\xa9\x55\x60\xb3\x6c\xcc\x42\x1d\x81\xad\xda\x15\xe2\xfc\x14\x19\x9e\x48\x27\x07\x78\x93\xff\x9d\xa0\x65\xb7\x16\x16\xb2\x59\xe3\xa9\x29\xda\xd6\xf2\x32\x20\x4a\x56\x85\x06\xc2\x92\x98\xf3\x00\xa9\xa5\xe6\x98\xaf\x22\x7f\x09\x8d\xc2\xb6\x24\xc9\x26\x05\x6b\x8e\x41\x47\x5c\x88\x88\x08\xf8\xb0\xdc\xc9\xe3\xbd\x3c\x94\xde\xd6\x9f\x2f\xdb\x12\x00\x96\x97\xb3\xcb\x12\x08\xb2\x0c\x65\xa8\x49\xa6\x29\xaf\x95\x72\xd7\x04\x74\x6f\x01\x1b\x3e\xfc\x84\x1e\x6e\x6a\x5a\xc5\x2a\x2f\x97\xe1\x77\x6c\x8c\x33\xc2\x65\x23\x0b\x63\x59\x13\xbf\x4e\xb0\x9a\xf9\x9e\xdf\x71\xde\x36\xa7\xd4\xff\x6c\xa3\x00\x11\x12\xbf\x2e\x4b\x65\xcb\x2a\x97\x41\x7d\x10\xf5\x30\x61\x90\xb9\x2f\x13\x33\x85\xb6\x0a\x4f\x59\x52\x99\x1d\xb8\x2c\xd9\xba\xa9\x67\x37\x3a\xe4\x6e\x16\xb5\xf2\xe3\x04\x01\xff\xc2\x5f\xf1\xee\x24\xa3\x5a\x59\x14\x20\x19\x9a\xb6\xcc\x40\x25\xa9\x8c\x38\xb6\x8d\x9f\x10\x19\x74\x2a\x39\x68\x78\x24\x8a\x70\x55\xef\xb3\x9b\xaa\x14\xf3\x3b\xed\x67\xc9\x85\x99\xaf\xf8\x9f\xdc\x8d\xfa\xbd\x26\x40\x95\x5d\x01\x0e\x0d\x02\xe5\x62\xfb\x8f\x91\xb4\xe5\x72\x46\xad\xbb\x6f\x46\xf8\x89\xff\xfd\xe9\x00\x6e\xbc\xf5\x14\x1c\x02\xb8\x3c\x0e\x10\x85\xfe\x3c\xe5\x01\x2e\xf1\xff\x4a\x14\xd0\x55\xb1\x6c\xbb\x0a\x0e\x95\x60\xe0\x21\x47\x9e\xf0\xd4\x2e\x57\x3b\x6d\x40\xa5\x5e\x95\x3c\x01\x46\x03\xf4\xc4\x5d\x6e\xbf\xf0\xa9\xf8\x74\x24\x58\x6b\xfa\xf8\x22\x01\xba\x07\x01\xe9\xb6\x6b\x2a\xa7\x06\xd8\xfd\xe8\x29\x78\x04\x65\x32\x20\x7c\x93\x4e\xf5\x9c\x77\xf9\xfe\x3b\x49\xc0\xdf\xf2\xff\x76\x54\xac\x5a\x3e\x01\x6a\x5a\x04\x2f\xf6\x89\x59\xb2\x56\x8e\x4e\x09\xf0\x3c\x7b\xd9\x5e\xc1\xc7\x37\xaa\x61\x0a\x28\x85\x02\x96\xb7\x9d\x17\x4a\x16\xf0\x9f\x2e\xe0\x20\xe3\x87\xd2\x42\x00\x43\x54\x0c\xdf\xa6\x97\x14\x17\xf0\x6f\xc9\x01\xde\x71\x01\xbb\x6f\xb5\x08\x80\x61\x12\x5c\x5e\x7e\x90\xea\x30\x1d\x9f\x4f\x16\x90\x85\x07\x65\xd1\x0e\x3b\x75\x38\xa0\xdf\x24\xad\x95\x0d\x0a\x58\x3c\x9f\xec\x62\xe2\x0b\xfa\xb2\x9d\x80\x86\xc3\x24\x38\xf4\xb0\x1f\x50\x72\x8c\xb0\xf8\x22\x59\xc0\x05\x0a\x78\x94\xd1\xfc\x11\x78\x8c\x04\xb5\x31\xdc\xfe\xc3\xd2\x57\x14\x07\x30\xb9\x9e\xe4\x19\x02\x92\xd7\x7d\x71\x37\x28\x2e\x49\xd2\xc6\x00\x4a\xe3\xf2\x33\x1b\x19\xf6\x4e\xda\xe2\x46\x82\x80\x6b\x3c\x7f\x48\x00\x95\xa5\xcc\x50\x12\x1b\x66\xc4\x1f\xb4\x80\x94\xe1\x27\xff\x01\x56\x7b\x81\x4a\xf0\x30\xda\xfb\xdf\x23\x01\xbe\xe6\xb9\x1a\x01\xac\xcf\x5b\xa3\xfa\x0c\x30\xc2\x77\x8e\xc0\xc8\x13\x23\xc5\x4d\x79\x85\x1a\x61\xb1\xc6\x45\xba\xfd\x42\x24\xc0\xdb\xce\x3b\x9c\x6b\x17\xcb\x63\x7c\x84\x92\x68\x4c\x9d\xda\xc8\x63\x01\x95\x4b\xdb\xd4\x08\xf1\x4d\xe6\xb7\x93\x02\x7c\xc4\xa7\xe8\x5b\xc4\x17\xb6\xa5\x90\x14\xc1\x06\x0b\x33\x92\x2b\xbc\xd1\x68\x94\x4e\xd5\x8b\xe4\x76\x20\x29\xfe\x51\x52\x80\xff\xe2\x97\xd8\x1b\xd7\xc3\x00\x5d\xa8\xb2\x24\x0d\xe3\x0d\x01\x3e\x98\xa3\xa1\x5a\xb9\x92\x1c\xe0\x1d\x16\x65\x94\xf3\xdb\xcb\xe1\x71\x5a\xf3\x03\x86\x1f\x67\xb5\x6b\x45\x96\xeb\x7e\x9b\x10\xe0\x9a\xe3\x23\xca\xd2\xcf\x23\x27\x0e\xf8\x08\x03\x9c\x14\x07\x5d\xc0\xe2\x42\x62\x61\xe6\xf7\x7c\xea\x2a\x05\xfc\xe9\xe7\x71\x27\xd6\x98\xd4\x20\x9e\x68\xe5\xb2\x87\xa7\xe1\x18\x05\x5c\xb9\x4a\x25\x18\xcd\x8d\xb9\x48\x4e\xfc\xa1\xc3\x24\x78\x37\xb4\x4c\x81\xae\x93\xa8\xd8\x92\xfc\xd6\xa8\x8d\x4a\xb0\xbc\xcd\x54\x5c\x8b\x14\x08\xb9\x48\x61\x70\x8e\xf5\x3a\xe7\xef\x86\xab\x4e\x23\x8c\x1e\x60\x58\xd9\x58\x4e\x33\xc0\xe4\x54\x0c\xd7\x59\x63\xe9\x29\xb3\x3c\xa9\x98\x01\x46\x0b\x54\xac\x69\xda\x24\x1b\xcc\x28\x81\x7b\x59\x24\x22\x41\x8e\x02\xe6\x5b\x96\x36\xd9\x8b\xad\x8f\xe5\xa9\x4e\x92\x65\x77\x3d\x48\x4e\x82\x6e\x22\x51\x8a\x5b\x21\x71\xd0\xf1\x93\xf2\x5b\xab\x6c\x8d\x30\x06\x8a\xf0\x72\x8b\xbd\xd6\x61\x62\x36\xf8\x88\xff\x86\x26\x12\xc8\x4f\xd6\xf8\x7e\x52\x22\x8a\x85\x2f\xbb\x3f\x5b\xd2\x48\x15\x16\x08\xda\x4c\x80\xe4\x86\x2a\x09\x79\xb1\xd7\x32\x41\x53\x37\x5c\xba\x0c\x15\x56\xd6\xb6\x35\x5a\x25\xfa\x1f\xb0\x6a\xee\xad\xaf\x52\x51\x66\x67\xa2\x2d\x85\x2d\xb0\x17\x55\xf2\x5d\x29\xa4\x54\x66\xa2\xb4\x7e\x2e\x4f\x04\xd4\x54\xc5\xb9\xf1\x46\xb4\x5c\xc7\x45\x4b\x24\x0e\x60\xa8\x11\xba\x8d\x6f\x7a\xd4\x47\x02\xf1\x32\xeb\xdd\x6c\x23\x52\xe3\xc9\x45\xaa\x65\x5a\x2e\xe0\xc6\x64\x40\xcd\x4a\x97\x27\x03\x76\xdd\x3b\x97\x44\xcb\x75\x91\x00\x97\x9c\x3b\x50\x28\xf9\x28\x80\x93\x54\x2c\x6d\xe5\x9d\x3b\x6e\xa0\x1b\xaf\x25\x01\x48\x7b\x4e\x25\x4f\xee\xf4\xdb\x3f\x31\x60\x91\xdd\x6d\x03\xdc\x38\xca\x2d\xf5\xb8\x08\x26\x48\xf2\x88\x92\xef\x61\x42\x9e\x6a\x83\x53\x9c\xa4\x8c\x80\x2d\x7a\xff\x79\x25\x4a\xc9\xca\x45\x37\xc1\x4e\x7f\xd8\x8b\xc7\x02\x4e\x0e\x33\x65\x0c\x83\x1b\x3d\x7a\x3f\x9a\x28\x5e\x32\x1d\xf0\x7f\x20\x0a\x12\x1b\x7c\x31\x0f\xaf\xd9\x9d\xdc\xb8\x4f\x05\x24\x71\xfa\xd2\xa0\x48\x5e\xf2\x45\x22\x4e\x02\x51\x50\x41\x11\xd6\x53\x73\xa0\x99\xae\x15\x03\x50\x0b\x78\x71\xbe\x95\xba\x42\xbd\xae\x16\xc1\x4b\xa6\x03\xfe\x85\x5f\x6a\xf5\x10\xf0\x1b\xae\x93\x2f\x6e\x45\x00\x1c\x09\xdf\x9a\xdf\x06\xc1\x56\xe6\xd0\x68\x8a\xf5\xd6\x42\x22\x12\x7c\xc6\x73\x1b\x3d\x50\x2e\xf8\x1c\x54\x85\x1b\x1f\x27\x01\x6a\x53\x01\xad\x0d\x2c\xa5\xc9\x64\x7f\xad\xf7\x4d\x22\x4e\x82\xb5\x42\xbd\x83\x80\x38\x45\x8f\x8b\x10\xe1\x84\x9a\x54\xde\x9e\x02\x78\x88\xa5\xf4\x1c\xbc\x5e\xab\xbe\x11\x65\xfa\x28\x4a\xaa\xbb\xc3\xd7\x3a\x60\x32\x4b\xfc\x55\x30\x9b\xb7\x93\x4a\x56\x2c\x16\x76\x47\x01\xfd\xb5\xc2\x86\x92\xaf\xfd\x11\x54\x9c\xaf\xb5\x96\xc0\x7c\x92\xaa\x66\x3a\xf0\x8a\xfd\xd4\x79\xa5\x58\xcb\x68\x53\x01\x97\x27\x03\x2a\x57\xf9\x4b\x10\x65\x3a\x47\xdc\x9d\xc4\x9a\xa6\xb9\x01\xe8\xa4\x76\xe9\x73\xeb\xbb\x5a\x7a\x1a\x60\x66\x72\xb5\x75\xf8\x5d\xeb\xd2\xa5\x8d\x7c\xf1\x6a\x2f\xda\x24\x75\xa4\xc6\xfd\x6f\xfc\xbf\x6b\xa0\x99\x4b\xfd\x8d\x6f\xff\x7b\x65\x52\xa4\x96\xb4\xf2\xf6\x83\x29\x80\xdf\xd6\x3e\x9f\x1b\x80\x49\x0f\x3e\x24\x37\x37\xf3\x15\x9f\x02\xd3\x51\x36\xce\xf5\xfb\xe7\x2f\x5a\x93\x01\x57\xee\x4e\x04\xfc\xb8\x70\xa3\x3b\xe8\x43\x94\xe9\x2c\xf0\xdf\x27\x37\xc3\xfa\x9a\x9f\xc7\xbb\xc4\xf7\xcf\x0d\xce\x7d\xfe\x78\x12\x40\xed\xe3\xfc\xa5\x01\xfe\x25\x93\x5a\x7f\xee\x4f\xb7\x93\x03\x04\xc2\x14\xbc\xac\x32\x18\x0c\x3e\x67\x26\x4c\xf3\x23\xe0\xf3\x89\x99\xae\x79\x6e\xaf\xdf\x29\x82\xb9\x44\xfd\x93\x25\x51\xe7\xa8\xbf\xe7\xb9\xa5\x16\x5a\xce\x5e\x75\x42\xd1\x8f\x80\xf7\x26\xd6\x0a\xeb\x7b\x03\xd0\xef\xc6\x3c\x1f\xf5\xcf\x4b\x45\x7e\xd3\x15\xc4\xfc\x2b\x47\x75\x90\xa1\x3a\xa1\x5c\x98\x0a\x68\xed\x0d\x7a\xf9\x56\x3f\x15\x99\xef\x18\x37\x23\x81\x78\xcd\x2d\x75\x6a\xa9\x95\x72\xb8\x11\x22\xe0\xfd\x89\x80\xff\xd5\x2f\x1e\x2e\xf1\x7c\xf4\xbf\x64\x71\x9c\xbb\x46\x41\x93\xf8\xe1\x1b\x9e\xb7\x26\x02\x6e\xaf\x48\x61\x4b\xee\x08\xc8\x9f\x5f\xf8\xc0\x1f\xe7\xde\xd4\xc7\xba\xb5\xda\x1a\x46\xd6\xb5\xdd\x29\x80\xe5\x70\x40\xcd\xc2\xf3\xfd\xfe\x38\x77\xb7\x3d\xe6\xfd\x07\x5f\x3f\xe2\xf8\xf4\xa4\xe9\x99\xf2\xbd\x76\x79\xc8\x77\x34\xdf\x64\xf5\x03\xa8\x2f\x8f\x77\x6b\xef\x18\x37\x48\xbc\x27\x4d\x06\xb4\x46\xe6\xe5\xbc\xa3\xef\x1e\xfb\x84\x31\x00\xdb\xe5\x50\x2f\x46\x40\x7e\x18\xd0\x57\xdd\x48\xf7\x8e\x7d\xb6\x38\x77\x11\xb5\x26\x04\x42\x02\xa8\x85\x01\x5a\x2b\x33\x01\x7c\x30\xc1\x4b\x10\x50\x1b\x9a\x7c\xf3\x26\xad\xad\xf6\x0c\x00\x39\xfe\xb9\x74\x3c\x40\x5f\xc7\xc2\xcf\x44\x82\xdb\x93\x00\x9f\x23\x60\xd8\x96\x85\x0c\xff\x8f\x59\x00\xb6\xad\xc9\x80\xcb\xa1\x80\xe9\x38\x7f\xea\xe1\x84\x5e\x32\x04\x23\x4d\x90\xa0\x16\xc3\x89\xe3\x00\xfe\x83\x7f\xa0\x4d\x02\xdc\x0d\x5b\x08\xd3\x62\x38\x71\x1c\xc0\xa0\x97\x0c\x85\x19\xd0\x62\x26\x6c\xd3\x47\x1c\x1f\x89\xa7\xe2\x95\xd0\x50\x8d\x80\xbb\x52\xd8\xd6\xad\xcc\xac\x00\xc3\xbd\x64\x12\xa0\x04\x89\xee\x97\xd9\x00\xf2\xbb\x5a\x28\xe0\x5d\xfe\x41\x28\xe0\xbd\x19\x49\xf0\x17\xfe\xae\x3f\xbf\xfa\x75\x3d\x06\x50\x73\x37\x0e\x94\x57\x66\xa5\x62\x28\x68\xc6\x01\x6a\x14\x30\x13\xb6\x01\x33\x8e\x8f\xc4\x04\x6c\x97\xbd\x22\x21\xb0\x35\x81\x48\x30\x4c\xc3\xbb\xb3\x03\xf4\x67\x8b\x21\xc0\x07\x21\x80\x5a\x3c\x1f\x89\x07\xf8\x8a\xbf\x1b\xd4\xac\xbb\x89\x07\x01\x77\xc7\x4e\x1d\x49\xf1\x7c\x24\xee\x5f\x40\xbb\x27\xf9\xb8\x02\x3b\x3f\x1e\x04\x9b\x2a\xdf\x36\xea\x58\x3e\x12\x57\xc5\x50\x55\x4b\xe3\x01\x33\xe3\x01\x21\x3f\xc7\xf2\x91\xd8\x7f\x38\xc0\x1a\x07\x88\xeb\xb1\x99\xf6\x58\x40\xc8\xcf\xe9\x58\x7f\x8c\x2b\x1e\x20\x44\x42\x5f\x0a\x0b\xec\xee\xd9\x9d\x00\xc8\xcd\x50\x82\xd0\x9e\x4b\xe3\xf6\x7e\x48\xbb\xc1\x99\x07\xf6\x34\xee\x93\x5b\x99\xa9\x8a\x51\xc7\xa3\x6f\x38\xd0\xc2\x00\x71\x57\x57\x7b\x96\x80\x17\x7c\x3a\x96\x02\x3a\xde\x5d\x19\x97\x8a\xe1\x98\x5d\x7e\xb6\x12\xbc\xe7\x6e\xe9\xd7\xa4\x49\x80\x9a\xc6\xf6\x60\xc6\x0a\xd3\x27\x00\xf4\x26\x10\x82\x80\xd6\xf6\x78\x40\x69\x7b\xb6\x12\xbc\x83\x19\x4d\xd3\x46\xbd\x64\x18\xd0\xd9\xd4\x1a\x2f\x4c\x9f\xe4\x0f\xa8\xfc\x2c\xb9\x21\x64\xa2\x04\x99\x14\x2d\x7e\xd6\x80\x2b\x96\xeb\x01\xd3\x00\xf1\x91\xcc\xcc\x01\x49\x40\xd6\x46\x22\xb5\xb5\x32\xd2\xd3\xa1\x91\x4a\x67\x01\xa8\x8d\x4b\x25\xbb\xed\xf2\x30\xa0\xc4\x66\x06\x67\x0e\x28\x8d\x24\x3b\x0c\xd4\x43\xc5\x82\xc4\x84\x78\x16\x36\xa8\x8d\x6c\x43\xc6\x54\x37\x54\xb0\x4a\xac\x57\xb1\xda\xb3\x06\xdc\x96\xb4\x91\x64\x47\xea\xc1\xe7\xd2\xb8\x5a\x61\xd6\x61\x06\xa7\x17\xb4\xe0\x7b\x0f\x29\xe0\x5d\x7e\xbb\x3c\x26\x15\x63\xc3\x3c\xd3\x4c\x02\x55\xbf\xb7\x11\xd4\xbf\x4d\xef\x2e\x8d\x3f\xc1\x86\x40\x92\x62\xb6\x4c\xf1\x01\x2f\xf8\x01\x7d\x6f\xf0\x94\x9e\xa3\x7b\x4b\xc3\xef\x54\x94\x62\x1b\x61\x5c\xc0\x5f\x18\xe0\xc8\x9e\xfe\xe7\xc4\xbd\xfd\x8d\x14\x43\xb7\x66\xed\x24\xcf\x7d\x80\x9a\xb7\x5b\x1e\x5a\xb7\xdd\xc0\x3e\x7e\x89\x6d\x07\x7f\x70\x16\x61\x46\x5a\x1e\x06\x44\x67\xbd\x1b\x78\xff\x86\xc4\xde\x7f\x30\xeb\x72\x0b\x6a\x6a\x17\xc3\x07\x88\x73\x94\xdb\xfe\x5d\xd4\xae\x23\xdd\x9b\xb1\x04\xff\x8e\x82\x1a\x71\x55\xba\xd0\x60\xf9\xde\xed\xe4\x04\xa3\xd9\x97\x5b\x3c\xf7\xc3\x0f\xbf\xfe\x7a\xe1\xd7\x5f\x7f\xf8\xf5\x87\x1f\x2e\x5c\x80\x4f\x38\x38\xf6\x0c\x3c\x78\x01\x07\x79\x16\x7e\xba\xf0\x03\x37\x73\xc0\xd9\x8c\xff\x00\xfe\x07\xf0\xac\xc7\xff\x01\xbc\xbe\xe8\x00\xdf\x3a\x46\xd7\x00\x00\x00\x00\x49\x45\x4e\x44\xae\x42\x60\x82');
    }
    return getPortraitPreviewBitmap.image;
}

function portraitPreviewPlacement(w, h, size, margin) {
    var eyeX = 80, eyeY = 32, crownY = 4, chinY = 51,
        unit = chinY - eyeY,
        top = Math.max(0, Math.min(.2, margin / 100)),
        // Keep the entire head when a requested close-up reaches the limit.
        q = Math.min(size / 100, (1 - top - .015) / (1 + (eyeY - crownY) / unit)),
        scale = q * h / unit,
        eye = h * top + scale * (eyeY - crownY);
    return { x: w / 2 - scale * eyeX, y: eye - scale * eyeY,
        width: 160 * scale, height: 240 * scale, eye: eye };
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

function bindSlider(row, setter, committed) {
    row.slider.onChanging = function () {
        var v = Math.round(this.value * 2) / 2;
        row.valueText.text = formatPercent(v);
        setter(v);
    };
    row.slider.onChange = function () {
        this.onChanging();
        if (committed) committed();
    };
}

function formatPercent(v) {
    return (Math.round(Number(v) * 10) / 10) + '%';
}

function Config() {
    var settingsObj = this;
    this.engine = '';
    this.useFaceCount = true;
    this.portraits = false;
    this.portraitSize = 22;
    this.portraitTop = 5;
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
                keys = ['engine', 'useFaceCount', 'portraits', 'portraitSize', 'portraitTop', 'vTop', 'vBottom', 'vSide', 'hTop', 'hBottom', 'hSide'];

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
    this.portraitPanel = { ru: 'Одиночные портреты', en: 'Single-person portraits' };
    this.portraitEnable = { ru: 'Согласовать крупность и линию глаз', en: 'Match face size and eye level' };
    this.portraitSize = { ru: 'Крупность портрета', en: 'Portrait size' };
    this.portraitSizeHelp = { ru: 'Числовое значение крупности для точного повторения настройки. Картинка обновляется после отпускания ползунка.', en: 'Numeric portrait size for repeatable settings. The image updates when you release the slider.' };
    this.portraitDirection = { ru: 'Общий план  ← →  Крупный план', en: 'Wider view  ← →  Closer view' };
    this.portraitTop = { ru: 'Отступ над головой, %', en: 'Space above head, %' };
    this.portraitTopHelp = { ru: 'Минимальный отступ над головой, в процентах высоты рамки. Используется только для одиночных портретов.', en: 'Minimum space above the head as a percentage of frame height. Applies only to single-person portraits.' };
    this.portraitPreviewHelp = { ru: 'Пример кадрирования. Зелёная линия — минимальный отступ сверху, синяя — автоматически рассчитанная высота глаз. Реальное размещение учитывает все выбранные портреты.', en: 'Framing example. Green marks the minimum top margin; blue marks automatic eye height. Actual placement accounts for all selected portraits.' };
    this.portraitHelp = { ru: 'Крупность и высота глаз согласуются автоматически. Отступ над головой — отдельный для портретов. Схема показывает пример, а не результат анализа ваших фотографий.', en: 'Face size and eye height are coordinated automatically. Portraits have their own head margin. The illustration is an example, not an analysis of your photos.' };
    this.portraitSolve = { ru: 'Согласование портретов...', en: 'Matching portrait composition...' };

    this.prepareLayers = { ru: 'Подготовка слоёв...', en: 'Preparing layers...' };
    this.title = { ru: 'Выравнивание и вписывание', en: 'Align and fit layers' };
    this.err = { ru: 'Скрипт остановлен', en: 'Script stopped' };
    this.errDoc = { ru: 'Нет активного документа!', en: 'No active document!' };
    this.errLayers = { ru: 'Не выбраны слои для выравнивания.', en: 'No layers are selected for alignment.' };
    this.errLayerBounds = { ru: 'Не удалось получить границы слоя', en: 'Cannot read layer bounds' };
    this.errCloudMode = { ru: 'Облачный Select Subject недоступен в этой версии Photoshop.', en: 'Cloud Select Subject is not available in this Photoshop version.' };
    this.errFallbackFrame = { ru: 'Не удалось определить нижний выбранный слой для fallback.', en: 'Cannot determine the bottom-most selected layer for fallback.' };
    this.errFallbackClipped = { ru: 'Нельзя использовать fallback: самый нижний выбранный слой уже находится в clipping. Работа скрипта остановлена.', en: 'Fallback cannot be used because the bottom-most selected layer is already clipped. The script has been stopped.' };
    this.errMatching = { ru: 'Не удалось подобрать рамку для слоя', en: 'Could not assign a frame to layer' };
    this.warningTitle = { ru: 'Нехватка рамок', en: 'Missing frames' };
    this.warnFrameCount = { ru: 'Не хватает рамок с соответствующими цветовыми метками: %MISSING% из %TOTAL%.\n\nЕсли продолжить, скрипт обработает слои, для которых есть рамки. Остальные слои останутся на исходных позициях.', en: 'There are not enough frames with matching color labels: %MISSING% of %TOTAL%.\n\nIf you continue, the script will process layers that have matching frames. The remaining layers will stay in their original positions.' };
    this.warnFrameDetails = { ru: 'По цветовым меткам:', en: 'By color label:' };
    this.continueButton = { ru: 'Продолжить', en: 'Continue' };
    this.stopButton = { ru: 'Остановить', en: 'Stop' };
    this.progressTitle = { ru: 'Выравнивание и вписывание', en: 'Align and fit layers' };
    this.startPython = { ru: 'Запуск Python...', en: 'Starting Python...' };
    this.prepareImages = { ru: 'Подготовка изображений', en: 'Prepare images' };
    this.restoreLayers = { ru: 'Восстановление слоёв...', en: 'Restore layers...' };
    this.analyzePython = { ru: 'Анализ изображений Python...', en: 'Analyze images in Python...' };
    this.detectBounds = { ru: 'Границы объекта', en: 'Object bounds' };
    this.readFrames = { ru: 'Чтение рамок', en: 'Read frames' };
    this.matchFrames = { ru: 'Согласование рамок...', en: 'Match frames...' };
    this.align = { ru: 'Выравнивание', en: 'Align' };
    this.done = { ru: 'Готово', en: 'Done' };
    this.enginePanel = { ru: 'Определение границ объекта', en: 'Object bounds engine' };
    this.offsetPanel = { ru: 'Отступы объекта от рамки, %', en: 'Object margins inside frame, %' };
    this.verticalFrame = { ru: 'Вертикальная рамка', en: 'Vertical frame' };
    this.horizontalFrame = { ru: 'Горизонтальная рамка', en: 'Horizontal frame' };
    this.topOffset = { ru: 'Сверху', en: 'Top' };
    this.bottomOffset = { ru: 'Снизу', en: 'Bottom' };
    this.sideOffset = { ru: 'По бокам', en: 'Sides' };
    this.okButton = { ru: 'Выполнить', en: 'Run' };
    this.save = { ru: 'Сохранить настройки', en: 'Save settings' };
    this.cancel = { ru: 'Отмена', en: 'Cancel' };
    this.useFaceCount = { ru: 'Учитывать количество лиц при подборе рамок', en: 'Use face count when matching frames' };
    this.enginePython = { ru: 'Python', en: 'Python' };
    this.engineDevice = { ru: 'autoCutout — on device', en: 'autoCutout — on device' };
    this.engineCloud = { ru: 'autoCutout — in cloud', en: 'autoCutout — in cloud' };
    this.engineLayer = { ru: 'Границы слоя', en: 'Layer bounds' };
    this.descPython = {
        ru: 'Быстрый анализ уменьшенных изображений внешним модулем. Определяет границы группы и примерное число лиц. При включенной опции число лиц учитывается при подборе рамок.',
        en: 'Fast external analysis of reduced previews. Detects the group bounds and an approximate face count. When enabled, face count is also used when matching photos to frames.'
    };
    this.descDevice = {
        ru: 'Photoshop Select Subject: обработка локально на устройстве. Быстрее Cloud, но обычно менее точно определяет границы объекта. Число лиц не определяется.',
        en: 'Photoshop Select Subject processed locally on the device. Faster than Cloud, but usually less accurate at determining object bounds. Face count is not detected.'
    };
    this.descCloud = {
        ru: 'Photoshop Select Subject: обработка в облаке. Медленнее Device, но обычно точнее определяет границы объекта. Число лиц не определяется; требуется интернет.',
        en: 'Photoshop Select Subject processed in the cloud. Slower than Device, but usually more accurate at determining object bounds. Face count is not detected; internet access is required.'
    };
    this.descLayer = {
        ru: 'Без детекции объектов и лиц. Слои и рамки согласуются по пропорциям; затем весь слой центрируется и масштабируется так, чтобы гарантированно перекрыть рамку. Настройки отступов не используются.',
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

// The JPEG path is already technical. Photoshop also derives the temporary
// PSB document name from the source layer BEFORE JPEG export. Guard that name
// only when unsafe, so ordinary layers incur no extra Action Manager call.
function unsafeTemporaryLayerName(name) {
    name = String(name == undefined ? '' : name);
    return !name.length || name.length > 120 ||
        /[\x00-\x1f\x7f-\x9f<>:"\/\\|?*\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(name) ||
        /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

function protectTemporarySmartObjectName(id, name) {
    if (!unsafeTemporaryLayerName(name)) return;
    lr.setName('AlignFitPreview_' + id);
    // The existing common preview history rollback restores the original name.
}

function convertActiveLayerToSmartObject() {
    executeAction(stringIDToTypeID('newPlacedLayer'), undefined, DialogModes.NO);
}

function openActiveSmartObjectContents() {
    executeAction(stringIDToTypeID('placedLayerEditContents'), undefined, DialogModes.NO);
}


function reselectLayers(ids) {
    if (!ids || !ids.length) return;
    if (ids.length > 2) {
        try {
            // Bulk-select all except the final ID. Select that ID separately so
            // the active layer is identical to the former sequential loop.
            var r = new ActionReference(), d = new ActionDescriptor(), s2t = stringIDToTypeID;
            for (var j = 0; j < ids.length - 1; j++) r.putIdentifier(s2t('layer'), ids[j]);
            d.putReference(s2t('null'), r);
            d.putBoolean(s2t('makeVisible'), false);
            executeAction(s2t('select'), d, DialogModes.NO);
            lr.selectLayer(ids[ids.length - 1], true);
            return;
        } catch (e) {
            if (e.number == 8007) throw e;
            // Compatibility fallback resets any partially changed selection.
        }
    }
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
    // Cache is scoped to matching/alignment of this run, never to live bounds.
    var cache = runCtx && runCtx.placementSolutions;
    if (!cache || subject.id == undefined || frame.id == undefined) {
        return calculateObjectPlacementSolution(subject, frame);
    }
    var key = String(subject.id) + ':' + String(frame.id), entry = cache[key];
    if (entry) return entry.solution;
    var solution = calculateObjectPlacementSolution(subject, frame);
    cache[key] = { solution: solution };
    return solution;
}

function calculateObjectPlacementSolution(subject, frame) {
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
        rawBottomGap = subject.bottomGapRatio != undefined && isFiniteNumber(Number(subject.bottomGapRatio)) ?
            Number(subject.bottomGapRatio) * layerH : bottomSpace,
        bottomOpenWeight = Math.max(0, Math.min(1, (edgeToleranceY * 4 - rawBottomGap) / (edgeToleranceY * 3)));

    // Blend uncertain near-edge detections instead of flipping composition on
    // a single preview pixel. A true edge touch still uses the top anchor fully.
    bottomOpenWeight = bottomOpenWeight * bottomOpenWeight * (3 - 2 * bottomOpenWeight);

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
            scaleLR = Math.max(
                (targetX - (Number(frame.left) - bleed)) / leftFromAnchor,
                ((Number(frame.right) + bleed) - targetX) / rightFromAnchor
            ),
            minCover = Math.max((frameW + 2 * bleed) / layerW,
                (frameH + bleed - desiredTop) / belowTopAnchor),
            centeredScale = Math.max(minCover, scaleLR),
            // Side gaps are a stopping limit, never a reason to enlarge an
            // already centered object. At a coverage-bound translation, this
            // is the scale where the near-side object gap reaches its margin.
            nearSpace = anchorLocalX < layerW / 2 ? localLeft : rightSpace,
            sideStop = Math.max(eps, frameW - 2 * desiredSide) / subjectW;
        if (nearSpace > eps) sideStop = Math.min(sideStop, (desiredSide + bleed) / nearSpace);
        var scale = Math.min(centeredScale, Math.max(minCover, sideStop)),
            topMargin = desiredTop;

        // Preserve the existing compromise when the source lacks headroom:
        // reduce the top gap instead of magnifying just to create that gap.
        if (localTop * scale < desiredTop + bleed - eps) {
            if (localTop <= eps && bleed > 0) return null;
            scale = Math.max(scale, (frameH + 2 * bleed) / layerH);
            if (localTop > eps) scale = Math.max(scale, bleed / localTop);
            topMargin = Math.max(0, Math.min(desiredTop, localTop * scale - bleed));
        }
        if (!(scale > 0) || !isFiniteNumber(scale)) return null;

        // Pick the nearest feasible position to the visual center. Coverage is
        // hard; a residual X offset is allowed once side margins stop enlargement.
        var tx = clampValue(targetX - scale * anchorLocalX,
                Number(frame.right) + bleed - scale * layerW, Number(frame.left) - bleed),
            ty = Number(frame.top) + topMargin - scale * localTop;

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

    var fit = null, top = null;
    if (bottomOpenWeight < 1) {
        fit = chooseFitSolution(solveFit(preferredBleed), preferredBleed > 0 ? solveFit(0) : null);
    }
    if (!fit || bottomOpenWeight > 0) {
        top = solveOversized(preferredBleed);
        if (!top && preferredBleed > 0) top = solveOversized(0);
    }
    var solution = fit || top;
    if (fit && top && bottomOpenWeight > 0) {
        // Convex interpolation of complete affine placements preserves layer
        // coverage on all four sides. Do not interpolate scales alone.
        var w = bottomOpenWeight;
        solution = top;
        solution.scale = fit.scale * (1 - w) + top.scale * w;
        solution.tx = fit.tx * (1 - w) + top.tx * w;
        solution.ty = fit.ty * (1 - w) + top.ty * w;
        solution.bleed = Math.min(fit.bleed, top.bleed);
        solution.topMargin = solution.ty + solution.scale * localTop - Number(frame.top);
    }
    if (solution) solution.bottomOpenWeight = bottomOpenWeight;
    return solution;
}

function objectPlacementCost(subject, frame) {
    var solution = getObjectPlacementSolution(subject, frame);
    return solution ? placementCompositionCost(solution, frame) : 1000000;
}

function placementCompositionCost(solution, frame) {
    // One continuous score for every placement, with no branch-name penalty.
    // Fill uses the visible bbox intersection with the requested inner frame;
    // crop uses the full frame, so configured margins do not count as cropping.
    var scale = Number(solution.scale),
        fw = Math.max(0.000001, Number(frame.width)),
        fh = Math.max(0.000001, Number(frame.height)),
        left = Number(solution.tx) + scale * Number(solution.localLeft),
        right = Number(solution.tx) + scale * Number(solution.localRight),
        top = Number(solution.ty) + scale * Number(solution.localTop),
        bottom = Number(solution.ty) + scale * Number(solution.localBottom),
        ow = Math.max(0.000001, right - left),
        oh = Math.max(0.000001, bottom - top),
        il = Number(frame.left) + Number(solution.desiredSide),
        ir = Number(frame.right) - Number(solution.desiredSide),
        it = Number(frame.top) + Number(solution.desiredTop),
        ib = Number(frame.bottom) - Number(solution.desiredBottom),
        innerArea = Math.max(0.000001, (ir - il) * (ib - it)),
        filledArea = Math.max(0, Math.min(right, ir) - Math.max(left, il)) *
            Math.max(0, Math.min(bottom, ib) - Math.max(top, it)),
        visibleArea = Math.max(0, Math.min(right, Number(frame.right)) - Math.max(left, Number(frame.left))) *
            Math.max(0, Math.min(bottom, Number(frame.bottom)) - Math.max(top, Number(frame.top))),
        emptyFraction = 1 - Math.min(1, filledArea / innerArea),
        cropFraction = 1 - Math.min(1, visibleArea / (ow * oh)),
        centerX = Number(solution.tx) + scale * Number(solution.visualCenterLocalX),
        dx = Math.abs(centerX - Number(frame.center.x)) / fw,
        // A vertically oversized/open figure is anchored at its top. Fade out
        // the whole-object Y-center preference as vertical overflow increases.
        verticalOverflow = Math.max(0, Math.min(1, (oh - (ib - it)) / Math.max(0.000001, ib - it))),
        openWeight = Math.max(Number(solution.bottomOpenWeight) || 0, verticalOverflow),
        dy = Math.abs((top + bottom) / 2 - (it + ib) / 2) / fh,
        topLoss = Math.max(0, it - top) / fh,
        bottomLoss = Math.max(0, bottom - ib) / fh * (1 - openWeight);

    // Cropping is more costly than unused space; horizontal centering outranks
    // vertical centering. Bottom margin remains preferred for complete figures.
    return emptyFraction * 4 + cropFraction * 12 + dx * 8 +
        dy * (1 - openWeight) * 3 + topLoss * 4 + bottomLoss * 4;
}

function alignLayer(subject, frame) {
    var portrait = runCtx.portraitSolutions ? runCtx.portraitSolutions[String(subject.id)] : null;
    if (portrait) {
        var anchor = subject.portrait.eye, layer = subject.layer,
            targetX = Number(portrait.tx) + Number(portrait.scale) * (anchor[0] - Number(layer.left)),
            targetY = Number(portrait.ty) + Number(portrait.scale) * (anchor[1] - Number(layer.top));
        lr.transform(targetX - anchor[0], targetY - anchor[1], Number(portrait.scale) * 100, anchor[0], anchor[1]);
        return;
    }
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
        // their top-center. The solved target preserves the top anchor and
        // the closest feasible horizontal center without excessive enlargement.
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
    this.getDescriptor = function (id) {
        var reference = new ActionReference();
        reference.putIdentifier(target, id);
        return executeActionGet(reference);
    };
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
    this.setName = function (name) {
        (r = new ActionReference()).putEnumerated(s2t('layer'), s2t('ordinal'), s2t('targetEnum'));
        (d = new ActionDescriptor()).putReference(s2t('null'), r);
        (d1 = new ActionDescriptor()).putString(s2t('name'), name);
        d.putObject(s2t('to'), s2t('layer'), d1);
        executeAction(s2t('set'), d, DialogModes.NO);
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
        // Preview is detector input only. Nearest Neighbor is the cheapest
        // resampling method and avoids spending time on visual-quality filtering.
        d.putEnumerated(s2t('interpolation'), s2t('interpolationType'), s2t('nearestNeighbor'));
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
    var root = new Folder(local + '/JazzyScripts/' + RUNTIME_NAME);
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

    this.sendPayload = function (type, payload, delay, animateProgress) {
        var result = sendMessage({ type: type, message: payload }, delay, true, true, !!animateProgress);
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

    function sendMessage(o, delay, sendData, getData, animateProgress) {
        delay = delay ? delay : INIT_DELAY;
        var requestId = String((new Date()).getTime()) + '-' + (++requestSeq),
            listener = null,
            t1 = 0,
            t2 = 0,
            t3 = 0;
        o.request_id = requestId;

        if (getData) {
            listener = new Socket();
            if (!listener.listen(portListen, 'UTF-8')) return null;
            t1 = t3 = (new Date()).getTime();
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

            // app.updateProgress() does not advance a nested
            // app.doProgressSegmentTask() reliably. Use the same pattern as the
            // API img2img helper: while polling the socket, repeatedly add a small
            // doProgressTask() slice to the *current* analysis segment. The
            // exponential curve approaches 95% of the segment and leaves its end
            // for the actual Python reply.
            if (animateProgress && t2 - t3 >= API_POLL_INTERVAL) {
                var progressDelta = t2 - t3,
                    slice = progressDelta > 0
                        ? 1 - Math.pow(1 - PROGRESS_STAGE_TARGET, progressDelta / PYTHON_ANALYZE_EXPECTED_MS)
                        : 0;
                if (slice > 0 && !app.doProgressTask(slice, 'pythonAnalysisProgressChunk();')) {
                    if (listener) listener.close();
                    var cancelError = new Error('User cancelled');
                    cancelError.number = 8007;
                    throw cancelError;
                }
                t3 = t2;
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
            $.sleep(animateProgress ? API_POLL_SLEEP : 1);
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
