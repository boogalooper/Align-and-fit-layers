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

var SCRIPT_VERSION = '0.7.10',
    SCRIPT_NAME = 'Align and fit layers',
    UUID = '5a2946a7-c3d1-430b-8527-c854f5bb7241',
    API_HOST = '127.0.0.1',
    API_PORT_SEND = 6320,
    API_PORT_LISTEN = 6321,
    API_FILES = ['lib/align-fit-api.pyw', 'align-fit-api.pyw'],
    RUNTIME_NAME = 'AlignFitRuntime',
    EXPECTED_SERVER_VERSION = '0.6.3',
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
    // The engine key is present in every descriptor written by this script.
    // Do not infer playback from descriptor.count: Photoshop may add its own
    // terminology keys, and the settings schema can grow independently.
    var actionParameters = app.playbackParameters,
        fromAction = actionParameters.hasKey(stringIDToTypeID('engine')),
        editAction = fromAction && app.playbackDisplayDialogs == DialogModes.ALL;

    cfg.getScriptSettings(fromAction);
    cfg.resolveEngine(fromAction && !editAction);
    if (!fromAction || editAction) {
        var w = dialog(editAction), result = w.show();
        if (result != 1) {
            isCancelled = true;
        } else if (editAction) {
            // Editing the action step changes only its descriptor, not the PSD
            // or the defaults used by a later independent manual run.
            cfg.putScriptSettings(true);
        } else {
            runWithPhotoshopProgress();
            // Publish recordable parameters only after successful processing.
            cfg.putScriptSettings(true);
            cfg.putScriptSettings(false);
        }
    } else {
        runWithPhotoshopProgress();
    }
} catch (startupError) {
    // 'cancel' is Photoshop's script result for aborting the current action.
    // A failed/cancelled run must not become a successful recorded action step.
    isCancelled = true;
    if (!(startupError.number && startupError.number == 8007)) {
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
    if (app.doProgress(L(str.progressTitle), 'runScript();') === false) throw makeUserCancelError();
}

function runScript() {
    var runError = null;
    try {
        cleanupStaleTempFiles();
        if (app.doProgressSegmentTask(10, 0, 100, 'prepareRunContextStage();') === false) throw makeUserCancelError();

        if (app.doProgressSegmentTask(90, 10, 100, 'runPreparedStages();') === false) throw makeUserCancelError();
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
            if (app.doProgressSegmentTask(28, 0, 100, 'preparePythonStage();') === false) throw makeUserCancelError();
            if (app.doProgressSegmentTask(4, 28, 100, 'analyzePythonStage();') === false) throw makeUserCancelError();
            runCtx.subjectSegmentStart = 32;
            runCtx.frameSegmentStart = 44;
            runCtx.matchSegmentStart = 64;
            runCtx.alignSegmentStart = 70;
        } else if (cfg.engine == 'device' || cfg.engine == 'cloud') {
            configurePhotoshopSelectionMode();

            // Measure Select Subject inside the layer's own temporary Smart Object.
            // No JPEG export and no resize are used for Photoshop autoCutout modes.
            if (app.doProgressSegmentTask(35, 0, 100, 'prepareAutoCutoutStage();') === false) throw makeUserCancelError();
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
            visible: info.visible,
            smartObject: info.smartObject,
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
        if (app.doProgressTask(slice, 'preparePythonPreviewChunk(' + i + ');') === false) throw makeUserCancelError();
    }
}

function preparePythonPreviewChunk(i) {
    var id = runCtx.subjectTargetIds[i],
        meta = runCtx.layerMeta[String(id)],
        name = meta ? meta.name : lr.getProperty('name', false, id),
        text = L(str.prepareImages) + ': ' + (i + 1) + '/' + runCtx.subjectTargetIds.length + ' — ' + name;
    app.activeDocument = runCtx.sourceDoc;
    lr.selectLayer(id);
    if (!meta.visible) lr.setLayerVisiblity(id, true);
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
        if (app.doProgressTask(slice, 'prepareAutoCutoutChunk(' + i + ');') === false) throw makeUserCancelError();
    }
}

function prepareAutoCutoutChunk(i) {
    var id = runCtx.subjectTargetIds[i],
        meta = runCtx.layerMeta[String(id)],
        name = meta ? meta.name : lr.getProperty('name', false, id),
        text = L(str.detectBounds) + ': ' + (i + 1) + '/' + runCtx.subjectTargetIds.length + ' — ' + name;
    app.activeDocument = runCtx.sourceDoc;
    lr.selectLayer(id);
    if (!meta.visible) lr.setLayerVisiblity(id, true);
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
        // The caller has already activated the document and selected this layer.
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
        return out;
    } catch (e) {
        try {
            if (smartDoc) {
                app.activeDocument = smartDoc;
                doc.close(false);
                smartDoc = null;
            }
        } catch (ignore0) { }
        if (e.number == 8007) throw e;
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

    if (app.doProgressSegmentTask(f0 - s0, s0, 100, 'collectSubjectsStage();') === false) throw makeUserCancelError();
    prepareFrameList();
    if (app.doProgressSegmentTask(m0 - f0, f0, 100, 'readFramesStage();') === false) throw makeUserCancelError();
    if (app.doProgressSegmentTask(a0 - m0, m0, 100, 'matchFramesStage();') === false) throw makeUserCancelError();
    preparePortraitPlacements();
    if (app.doProgressSegmentTask(100 - a0, a0, 100, 'alignSubjectsStage();') === false) throw makeUserCancelError();
}

function collectSubjectsStage() {
    var n = runCtx.subjectTargetIds.length,
        slice = 1 / Math.max(1, n);
    for (var i = 0; i < n; i++) {
        if (app.doProgressTask(slice, 'collectSubjectChunk(' + i + ');') === false) throw makeUserCancelError();
    }
    runCtx.subjects.sort(function (a, b) { return a.ratio > b.ratio ? 1 : -1; });
}

function collectSubjectChunk(i) {
    var id = runCtx.subjectTargetIds[i],
        meta = runCtx.layerMeta[String(id)],
        layerName = meta ? meta.name : lr.getProperty('name', false, id),
        text = L(str.detectBounds) + ': ' + (i + 1) + '/' + runCtx.subjectTargetIds.length + ' — ' + layerName;

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

    subject.color = meta ? meta.color : lr.getProperty('color', false, id)[1];
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
        if (fromPython && analysis.visual_center_x != null && isFiniteNumber(Number(analysis.visual_center_x))) {
            subject.visualCenterX = Number(layerBounds.left) + Number(analysis.visual_center_x) * sx;
        }
        if (fromPython && cfg.portraits && Number(analysis.faces) == 1 && analysis.portrait) {
            var p = analysis.portrait, metricScale = Math.sqrt(sx * sy), metrics = [];
            for (var pi = 0; pi < p.metrics.length; pi++) metrics.push(Number(p.metrics[pi]) * metricScale);
            subject.portrait = {
                eye: [Number(layerBounds.left) + Number(p.eye[0]) * sx, Number(layerBounds.top) + Number(p.eye[1]) * sy],
                metrics: metrics,
                head: p.head > 0 ? Number(p.head) * metricScale : 0,
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
            info.visible = d.getBoolean(s2t('visible'));
            info.smartObject = d.hasKey(s2t('smartObject'));
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
    for (var i = 0; i < n; i++) if (app.doProgressTask(slice, 'readFrameChunk(' + i + ');') === false) throw makeUserCancelError();
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
    for (var i = 0; i < n; i++) if (app.doProgressTask(slice, 'alignSubjectChunk(' + i + ');') === false) throw makeUserCancelError();
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
        ok = buttons.add('button', undefined, actionMode ? L(str.save) : SCRIPT_NAME);

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
    var portraitPreviewState = { size: cfg.portraitSize, top: cfg.portraitTop },
        lastPortraitDiagramState = null;
    portraitDiagram.onDraw = function () {
        var g = this.graphics, w = Number(this.size[0]), h = Number(this.size[1]);
        if (!(w > 0) || !(h > 0)) return;
        g.newPath(); g.rectPath(0, 0, w, h);
        g.fillPath(g.newBrush(g.BrushType.SOLID_COLOR, [.94,.96,.96,1]));
        // The fixed image control is the viewport: native clipping crops the
        // larger bitmap. No file write, inference or full-dialog relayout.
        var pose = portraitPreviewPlacement(w, h, portraitPreviewState.size, portraitPreviewState.top);
        var active = portraitDiagram.enabled;
        g.drawImage(active ? getPortraitPreviewBitmap() : getDisabledPortraitPreviewBitmap(), pose.x, pose.y, pose.width, pose.height);
        var pen = g.newPen(g.PenType.SOLID_COLOR, [.35,.48,.48,1], 1),
            blue = g.newPen(g.PenType.SOLID_COLOR, active ? [.2,.6,.9,1] : [.68,.68,.68,1], 1);
        g.newPath(); g.rectPath(.5, .5, w - 1, h - 1); g.strokePath(pen);
        var marginPen = g.newPen(g.PenType.SOLID_COLOR, active ? [.3,.6,.4,1] : [.68,.68,.68,1], 1),
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
        chFaceCount.visible = pythonMode;
        chFaceCount.enabled = pythonMode;
        stDesc.text = engineDescription(key);
        pnMargins.enabled = key != 'layer';
        pnEngine.layout.layout(true);
        dlg.layout.layout(true);
        updatePortraitUI(pythonMode);
    }
    function updatePortraitUI(pythonMode) {
        var active = pythonMode && !!cfg.portraits;
        pnPortrait.enabled = pythonMode;
        rowPortraitSize.enabled = rowPortraitTop.enabled = portraitDiagram.enabled = active;
        if (!portraitDiagram.image) portraitDiagram.image = active ? getPortraitPreviewBitmap() : getDisabledPortraitPreviewBitmap();
        redrawPortraitDiagram();
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

    chPortrait.onClick = function () { cfg.portraits = !!this.value; updatePortraitUI(cfg.engine == 'python'); };
    function redrawPortraitDiagram() {
        var state = cfg.portraitSize + ':' + cfg.portraitTop + ':' + portraitDiagram.enabled;
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

// Generated boy preview: 160 x 240 px, 128 colors, alpha; 6193-byte PNG.
// Crown (80,7), eye midpoint (80,32), chin (80,52) are measured once on
// this illustration. They are not inferred from the user's photos.
function getPortraitPreviewBitmap() {
    if (!getPortraitPreviewBitmap.image) {
        getPortraitPreviewBitmap.image = ScriptUI.newImage('\x89\x50\x4e\x47\x0d\x0a\x1a\x0a\x00\x00\x00\x0d\x49\x48\x44\x52\x00\x00\x00\xa0\x00\x00\x00\xf0\x08\x03\x00\x00\x00\xb0\x9f\x9f\xe8\x00\x00\x01\x80\x50\x4c\x54\x45\xa4\x69\x4b\x56\x2a\x19\x49\x31\x20\x9e\x64\x46\x24\x22\x1f\x1b\x1e\x20\x1d\x24\x1c\x79\x6e\x1f\x61\x63\x5b\x60\x34\x21\x89\x53\x38\x8c\x53\x38\x2f\x24\x1c\xa0\x8a\x73\x77\x46\x30\x86\x52\x37\xbf\x7f\x3f\x99\x62\x46\xdd\xa1\x78\xec\xc5\xac\x38\x44\x44\x64\x37\x24\x75\x44\x2d\xd5\xa8\x89\xff\xff\x7f\x1e\x3b\x41\x00\x00\xff\x00\xff\xff\x7c\x4c\x34\xaa\xaa\x55\xff\xff\x00\x43\x43\x50\xbe\xa8\x9b\xff\xaa\x55\x00\x00\x00\x48\x6a\x71\x4e\x71\x78\x41\x46\x4f\x37\x44\x4b\x36\x3c\x43\xf2\xb7\x8e\x2f\x34\x3b\x3b\x5c\x63\x26\x29\x2f\x35\x54\x5b\xea\xac\x83\x51\x37\x25\x3e\x61\x67\xe6\xa4\x7a\xd8\x97\x6f\x67\x47\x30\xb5\x76\x54\xcc\x8a\x65\xaa\x69\x49\x18\x26\x2a\x00\x55\x55\x8c\x57\x3a\x13\x14\x17\x3a\x3b\x3d\x43\x2c\x1d\x55\x55\x55\xc5\x82\x5b\x0e\x14\x15\x1c\x34\x39\x91\x65\x49\xf8\xc1\x9a\x27\x44\x49\x77\x53\x3a\x3b\x27\x1a\x12\x28\x2b\x00\x3f\x3f\x0c\x0c\x0d\x16\x19\x1c\x1a\x24\x28\x55\x00\x00\xe1\x9c\x73\x10\x24\x26\x1a\x33\x37\x09\x17\x0f\x88\x5c\x42\x1c\x36\x3a\x22\x3d\x41\x5d\x40\x2c\x00\x00\x3f\x1b\x1d\x21\x21\x24\x29\x7f\x7f\x7f\xaa\x55\x55\x1b\x34\x38\xff\xff\xff\x18\x19\x1c\x16\x25\x28\x00\x7f\x7f\x25\x41\x46\xc4\x79\x57\x12\x29\x2c\x3c\x3c\x48\x1c\x1e\x22\x1c\x1e\x22\x7f\x00\x00\xff\x00\x00\x2f\x1c\x10\x35\x21\x15\x20\x3a\x3e\x22\x3d\x41\xb4\x86\x67\x00\x00\x7f\x1a\x25\x29\x1d\x36\x3a\x39\x25\x17\x79\x3c\x3c\x00\x00\x55\x16\x1c\x20\x18\x32\x36\x2f\x1c\x12\x21\x22\x26\x22\x3d\x42\x55\x55\x00\x6f\x57\x49\x8c\x56\x39\x32\x18\x08\x36\x23\x16\x25\x25\x27\x75\x46\x2c\xb9\x81\x5c\xff\x7f\x7f\x18\x1d\x22\x30\x08\x02\xcb\xfd\xa7\x97\x00\x00\x00\x80\x74\x52\x4e\x53\xd7\x27\xf3\x9c\x9d\xe3\x22\x0f\xfd\x59\xaa\xdd\x66\xfd\xd2\x68\x04\x6d\xfd\xfd\x17\xa6\x9d\xfd\x02\xc9\x01\x01\x62\x03\x01\x13\xfd\x03\x00\xfc\xfd\xfd\xfb\xfc\xfd\xfc\xfd\xfb\xfc\xfc\xfc\xfc\xfc\xfc\xfc\xfc\xfc\xfb\xf7\x03\xf9\x4d\x09\xfc\x03\xfc\x31\xf9\xfc\xfd\xce\xfd\xf8\x4f\x04\x2b\x6f\xae\x03\xfd\x35\x70\x13\xfb\xaf\xaf\xfd\x04\x8f\xd2\x02\x03\x8c\x01\x8d\x90\x02\xb0\xfc\x70\x16\xb0\xcb\x02\x01\x2b\x4d\x8b\x96\xfa\x02\xcd\xd0\xce\x04\x03\x74\x57\x4d\xb9\xd1\x03\xfd\x8f\x11\xac\x0a\x4c\xf9\x02\xfa\x15\x49\xfb\x46\x91\x00\x00\x15\xe0\x49\x44\x41\x54\x78\xda\xed\x9c\xf9\x63\xd3\x46\xda\xc7\x9d\x90\x84\x70\x76\x4b\xb7\xed\xb6\xdb\xdd\xf7\xdd\x91\x33\xb2\x0e\x5b\x92\x25\x1b\xe7\x70\xec\xe6\x80\xa4\xce\x45\x0a\x6d\x20\x90\x2c\x57\x29\x05\x5a\xae\x72\x95\x96\x7f\x7d\x9f\x67\x66\x24\x8d\x64\x87\x66\x6c\x24\xe7\x87\x0e\xcd\x65\x3b\xd5\x27\xcf\xcc\xf3\x7d\x8e\x19\xab\x40\x8e\xf8\x28\xfc\x05\xf8\x17\xa0\xc2\xf8\x86\x8d\x23\x0a\x28\x83\x7d\x48\xc8\x0f\x04\xc8\x88\xee\xde\x7d\x7a\xfa\x87\xa7\x3f\xdc\x8d\x1e\x38\x52\x16\x7c\x3a\xf6\x68\x69\x69\x76\x16\xff\x7b\x34\xf6\xf4\xd5\x11\xb3\xe0\xc6\xe9\x47\xb3\xb3\xa3\xa3\xb3\xb3\x8c\x10\x3e\x2d\x9d\xde\x38\x4a\x80\x4f\x1f\xcd\x56\xc4\x40\x38\x6e\xc6\xa7\x47\x07\x70\x6c\x09\xf9\xb6\x23\x46\xfc\x58\x5a\x5a\x1a\xdb\x38\x1a\x80\xaf\x5e\x0b\xf3\x21\xe1\x76\x55\x40\x02\xe0\xec\xeb\xa3\x00\xf8\xcd\xcc\xeb\x51\x86\x55\x65\xa3\x12\x4f\x35\xfc\xf7\xfa\xdd\x9d\x61\x03\x7e\x43\x4e\x33\xbb\x55\x17\x17\xab\xf1\x10\x90\xa3\x95\xd7\xe4\xf6\x70\x01\x6f\x93\x09\x98\xdf\xea\xe2\x66\x1b\x06\x7c\xda\x5c\x4c\xda\xb1\x72\x7a\x60\x41\x1c\xd0\x82\xbf\x3e\xaa\xa0\xf5\x70\x54\xab\x8d\xcd\x45\xf8\xb7\x59\x5d\xac\xe2\x83\xc0\xb9\x5d\x79\x34\xec\x29\xbe\x5b\x91\xa7\xb5\x5a\xdd\xe6\xdf\x57\xab\x9b\x60\xcd\xc5\xea\x76\xe5\x87\x41\x4d\x58\x18\x6c\x05\xbe\xae\xc4\x53\x3a\x5a\x65\x8c\x8d\x76\xc3\xf7\xdb\x68\xd6\x36\x98\x72\xe0\x55\x38\x98\x05\x37\x46\xb7\x39\x5f\xe3\xad\xe7\x95\x5d\x0f\x3e\x95\x4b\x38\xce\x35\x98\xe7\x54\xb7\x47\x87\x3b\xc5\x77\x67\xb7\x91\xaf\x11\x00\xd3\xd7\x38\x3e\xf9\xfa\x6b\x06\x58\xf2\xda\x48\x58\xdd\x9e\xbd\x3b\x44\xc0\xdb\xe4\xee\x28\xe3\xf3\x38\x94\x60\xe3\xc3\x7d\x3b\x5a\x81\x25\x39\x3b\x31\xe0\x22\x2c\x0c\xb4\x04\x27\x50\xa4\x17\x03\x97\xcd\x2b\x5a\x30\xe2\x2b\x97\x5d\x1f\x9d\x66\x60\x2f\x19\x0c\xf0\x07\x14\xe9\x4d\x4f\x00\x96\x24\xc0\x12\xac\x48\x54\x9a\x61\x03\xa2\x4c\xb7\x3d\xb7\xd4\x35\xc0\x82\x5e\x03\xa3\xf3\x70\x01\x9f\x02\xe0\x68\x5b\x58\xb0\x0b\x70\xb1\x32\x64\x40\xf0\xe2\x25\x40\x88\x01\xe5\x29\x06\xcd\x69\x60\xd2\x70\x77\xa8\x32\xf3\x6a\x69\xb4\x32\xea\x77\x5c\xd9\x45\xc2\x6f\x5c\xd7\x07\xfb\x2e\x0d\x17\x70\x02\x2c\xb8\xed\xb9\xee\xfd\x76\xbb\xd1\xf0\xcf\x09\x09\xf4\x37\x17\x1b\xed\xb7\xe7\x3a\x01\xcc\xff\xa3\x57\x43\x05\xfc\xfe\x51\x65\x76\xb1\xe3\xd5\x7c\xcf\x7b\xeb\xfb\x6f\xd9\x4c\x97\x7d\xdf\xbf\xef\x79\x7e\x2d\xf0\xc0\x89\x47\xbf\x1f\x26\xe0\x37\x64\xac\xb2\xd4\xe8\x04\x1e\x6a\x8c\xeb\x7a\x0c\xf0\x1c\x58\x94\x19\x12\x00\x67\x2b\x63\xe4\xdd\xf0\x00\xef\x90\x8f\x4f\x2d\x2d\x35\x00\xcc\x85\x59\xdd\x04\x33\x22\x61\x10\xd4\x20\x53\xa8\x41\x5c\xf6\x16\x97\x96\x0a\x1f\x93\x3b\xc3\x02\xfc\x9e\xfc\xb6\x57\x6e\x2f\xb5\xdd\x73\xde\xe6\x94\x65\x2d\xb5\x3d\x10\xc4\xaf\x5d\x2f\x98\xac\x58\x4b\x2f\x36\xe1\xa7\xc6\xb8\x5f\xf2\x8f\x93\xb9\x21\x01\xfe\x8d\x1c\x3b\x55\x2b\x57\xda\x6e\xd9\x6b\xff\x7f\x7b\xf4\xc5\x27\x60\x49\x70\xde\x72\xf0\x49\x7b\xfc\xc5\xe7\x35\xb7\xec\x56\xab\x6e\x0d\x4c\xf8\xb7\xe1\x01\xee\xed\xed\xd5\x1a\xa8\x82\xae\x77\xdf\x43\x75\xe6\x1f\x9f\x07\x18\x5c\xca\x2e\x24\x86\x7b\xb5\x63\x43\x05\x2c\x07\x05\x3f\x15\x47\xa2\x9f\xca\x9d\x5a\xad\xe9\xed\x0d\xcf\x82\xc7\xc9\xc7\x41\xa7\xd6\x68\x7a\xe5\x9e\x7c\xa5\xb2\xd7\x2c\xd4\x3a\xcd\x8f\xc8\xcf\x43\x02\xbc\x4d\x46\x02\x0f\xd4\x2e\x90\x98\x4a\x65\xe9\x07\x78\x6a\xcf\xf3\x47\x06\x4b\xfa\x07\x91\x99\x7f\x90\x63\x6e\xe0\x07\x81\x1b\x67\x08\xb8\xf2\x62\xc0\x66\x2d\x70\x8f\xc1\xcb\x86\x05\x08\x3a\x13\xb8\x41\xad\x19\x2d\x42\x94\x6a\xaf\x13\x66\xd6\xf0\x54\xd0\x09\x06\x54\x99\xc1\x22\xc9\xef\x60\x42\x10\xe9\x68\x11\x36\x37\x9b\xcd\x86\x2f\x00\x61\x09\x96\xcb\x9d\x63\x64\xc0\x58\x37\x58\x2c\xfe\x07\x29\x60\xe8\x88\x13\x56\x69\x41\x96\x03\xbf\x54\x2a\x90\x7f\x0d\x35\x59\x38\x4e\xde\x15\xbc\xcd\x66\xe4\x19\x89\x94\xbf\xd9\x08\x0a\x23\xf0\x92\xa1\x76\x16\x20\xce\x8e\xbc\x2b\xb8\x61\x51\x22\x65\xad\x30\xf5\x23\x23\x47\xa0\xfd\x86\x99\xc0\xb1\x0e\x0b\x26\x7e\xb0\xe7\x43\x64\xf1\x03\x9f\x05\x14\xf0\x5f\x42\x86\xde\x7e\x83\xf1\xf3\x9d\x91\x26\xd7\x96\x4e\x10\x74\xbc\x20\xf0\xb8\xe2\x34\x47\xee\xfc\x7c\x04\x2c\xc8\xd4\xe6\xa5\x98\x63\xb4\x9b\x2b\xbe\xe9\x9c\x04\x27\x3f\x1a\x80\x00\x12\xae\xc2\xb2\x27\x0a\x28\xb7\x53\x78\x77\xf5\xf6\x51\x01\xbc\x4d\xde\x35\x12\xa5\x27\xd6\xc4\x23\xe4\x83\xf0\x7d\x98\x6d\x88\xef\xc9\x67\x35\x4f\x4e\x18\x82\xc6\xd9\xdf\xff\x4d\x8e\x10\xe0\x9d\x97\x7e\xc3\x8f\x4c\xe8\xfa\x8d\xda\x29\x72\xf5\x08\x01\x1e\x27\x2f\x03\xbf\xd1\xe6\x51\xa4\x1c\x6c\x36\xfc\xe6\xc9\x41\x43\xdc\x07\x05\xfc\x99\x7c\xd4\x09\xfc\x5a\xa3\xe6\x43\xf1\xd9\x6e\xd4\xf6\x7c\xef\xd8\xc0\x31\xee\x43\x03\x96\x9a\x3e\x20\xc2\xa8\xf9\xcd\xa6\x07\x2a\xfd\x9f\xa3\x06\x58\x0a\xf6\xf6\xa0\x66\x07\x3c\xc8\xb1\x07\x4e\x03\x3f\xf0\x1a\xbc\xfa\x12\xf5\xd9\x6b\xf2\xe1\x81\x5e\x17\x8e\x90\x93\x9c\x07\x96\x02\x4b\x68\xce\x05\x80\x17\xb8\x65\x6c\xaf\x8e\x90\x5f\xcf\x1f\x0d\x40\xc4\x38\xd1\x14\xa1\x0e\x23\x09\x26\x0e\xae\x77\x32\x7c\x6e\xc8\x80\x80\x70\x7a\x6b\xb4\x99\x88\x23\x08\xe8\x7a\x67\x1f\xdc\x23\xe4\xfa\x90\x01\xd1\x42\x3b\xf6\x64\x50\x8e\x8b\x39\x5e\xbc\x43\xd2\xe0\xbe\x30\x17\x96\x09\x99\x3b\x3f\x3c\xc0\x0b\xf0\xb1\x4e\x4d\xcd\xbc\x2f\x57\xc3\xbc\xf4\x2c\x97\x5c\x4d\xd3\xe8\xa5\x35\x42\xbe\x3b\x3f\x1c\x40\x2c\xd6\x9e\x2c\xd8\x1a\x8e\x33\x61\xc9\x5e\xe6\x70\xf8\xdd\xa4\x56\x0c\x11\xaf\xce\xe4\x0e\xf8\x13\xe2\xad\x2f\x98\x1a\xa3\x28\x3a\x93\x9f\x4b\x6d\x05\xfc\x7c\x1f\xf8\x8a\x0c\xde\xbe\xb1\x2c\xfe\x9c\x1c\x01\xbf\x23\x64\xfe\x1e\x4c\x2e\x0e\xc0\x40\x94\xc9\x33\xac\x28\x61\x05\xc9\xe7\x67\x26\x9d\x90\x0f\x86\xb9\xb0\xbe\xd1\x37\x62\xa1\x3f\xd7\x58\xbb\x61\x73\xb2\x22\x07\x61\x9f\x26\xcf\x9c\xb9\x0f\xff\xce\x4c\x6a\x0e\x7b\x46\xc3\x27\xd9\xd0\xec\x7b\xf3\x7d\x8a\x4e\x1f\x80\xff\xe4\x78\xd2\x60\x84\xec\x8b\xa3\x39\x8e\x16\x1a\x2f\xf1\x12\xfb\xc7\xfe\x08\xfb\xb1\xe0\x7a\x12\x8f\x1b\x2b\x05\x2c\x99\x2f\x1c\x74\xb9\x1f\x59\x54\x06\xbc\x4e\x6e\xa4\xaf\x5c\x2c\x6a\x11\x56\x34\xe2\x67\xa2\x97\x9b\xeb\x39\x58\x70\x8e\xdc\xeb\xe6\x93\x0d\x17\xf1\x69\x69\xb3\x16\x8b\xf6\xb2\xfa\x2c\xab\x4f\x31\x2d\x1e\x3c\x22\x38\xf1\x7d\x72\x15\x68\xe6\x25\x75\x5f\x2e\xa8\x06\x8f\x65\x53\xeb\x5e\x74\xd1\x34\xa7\x1e\x09\xbd\xa7\x28\xb4\x88\x6e\x64\x3d\xc5\xdf\x91\x1b\xe2\x5a\xc5\x43\x0c\x2d\x7e\x1d\xff\x25\xf3\x09\x8b\x8f\x99\x4e\x31\x2d\xf6\x5a\x60\xef\x99\x73\xfe\xd5\xc4\x19\xd6\xb4\x1f\x95\xe7\xb8\xa0\x28\xd1\x6b\x36\xd3\x0f\xcd\x3c\x1c\x60\x24\x39\x66\xb1\x08\x02\xa9\x2d\x64\x3c\xc5\x33\x64\x9d\xc7\xb6\xc3\x01\x6a\x62\x1d\x6a\x45\x7c\x39\x46\x46\x7b\x3e\x5b\xc0\x39\x10\x41\x6e\x0e\xd3\x3c\xc4\xc4\xc6\xca\x63\xb3\xdf\x82\x38\xa3\x2c\x34\xaa\x6b\x70\xa1\xc8\x2f\x67\xda\xbd\xfc\xf6\x40\x6d\xb4\x99\x11\xc1\x86\xeb\x64\x26\x5b\x40\x1b\x2f\x09\xe6\x63\x80\xda\xe1\x1c\x19\x3e\x28\xa3\x33\x8b\x9a\xb2\x12\x16\xd4\xc2\xdc\x9a\x2d\x56\x20\x07\xd4\x0e\x61\x45\xe6\xf4\x54\xd3\x38\xe0\x42\xa6\x6b\xf0\x02\x79\xe2\x30\x40\xc8\xa3\xa9\x76\xb8\x39\x0e\x01\x4d\x9b\x01\xd2\x4c\x01\x67\xc8\x69\xa0\x73\xc0\x43\x4c\x06\x78\x58\x99\x91\x01\xd7\xb2\x04\x9c\x23\x3f\x22\xa0\xe6\x98\xb6\x4d\x0f\x31\xbd\x9a\x88\xc9\xc0\x65\xdb\x36\xd3\x1a\xe5\x7c\xa1\xa0\x18\xe8\x18\xa0\x06\x7c\x54\xfb\x73\x27\x09\xb3\x30\x06\x68\x72\xad\x59\x57\x0c\x76\x8a\x5e\xbc\xc0\xe3\x30\x3d\x1c\x20\xcf\x61\x50\xa7\x75\xb0\x38\x03\x74\xee\x29\xea\x8c\x22\x20\xe5\x17\x05\x3e\xe3\x60\xc0\xae\xf4\xba\x68\xb6\x28\x85\x95\x8b\xeb\x71\x4c\x51\x67\xd4\x00\xe7\x6d\x51\x7a\x50\xda\xd2\xba\x0b\x8f\x9e\xa0\xf8\x1a\xbb\x45\xcd\xa2\x6d\xe2\xf7\x37\xb0\x24\xcc\x08\x10\x53\x05\x71\xc5\x08\x30\x54\xe3\x94\xac\x88\x9c\x35\x24\xb4\x5b\x3a\x9b\xe1\xa2\x7a\xba\xa0\x06\xf8\xc4\x0c\x01\x75\x3d\xb6\xa0\xd6\x9d\x52\xcb\x61\x86\x01\x52\x9e\x71\xa9\xe7\xac\x05\x25\x19\x5c\x77\xc2\x55\x6f\xe8\x5a\xb2\x7a\x0b\x73\xe7\x70\x69\x46\xb9\x34\xa3\xaa\x83\xc8\x38\x1c\x70\x2d\x4b\xc0\x7b\xbc\x93\x00\x43\x6f\x99\x72\x01\xd7\x95\xc3\x46\x95\x72\x11\x75\x89\xd6\x35\x96\xa0\xa1\x31\x15\x85\xb0\xa0\xa8\xd3\x02\xb0\x48\xeb\x66\x5c\xbe\x1d\x50\x94\x68\x31\x60\x2b\x06\x7c\x92\x1d\x20\xea\x74\xd8\x36\xb0\xeb\xe6\x21\xbc\x98\xff\x0d\x00\xa8\x43\x06\xc4\x7f\x34\x15\x13\xae\x82\xa2\x4e\x87\x26\x34\x5b\xb6\x16\x2d\xc1\xf7\x56\xca\x98\xeb\xeb\x34\x06\xdc\xc9\x12\x90\x86\x73\x16\x03\xf6\xb2\xa2\x16\x89\x38\xb7\xa0\x09\x80\xa0\x82\xec\x27\x47\x31\x23\x54\x02\xdc\xa0\x61\x41\xa2\x69\x31\x60\xf7\x02\xd4\x22\x09\x62\x9f\x1d\x5b\xa7\x8e\x2d\x1e\x73\x16\xd4\x36\x28\x14\x00\x7f\x62\x3a\xad\x89\xf2\xa7\x45\x7b\x4d\x71\xb2\x18\x09\xdd\xd8\x36\xa8\x19\x02\xaa\x2a\x75\x41\x45\xa7\x97\x4d\x7e\x45\x90\x34\x47\xa7\x6c\xf9\xff\x49\xe1\xc4\xff\x04\x8c\x74\x66\x08\xa8\xa8\xd4\x0a\x80\x17\x30\x90\x44\x73\x1c\x03\xf6\xf2\x64\x4d\x5e\x83\xa0\x32\xd4\x8e\x64\x93\xce\x67\x05\x88\x81\x24\x34\x09\xa4\x0b\xba\xa6\x69\xe6\x01\x19\x43\xaa\xee\x04\x0b\xc6\x2e\x65\xaf\x29\x09\x61\x41\x2d\x90\x84\x80\xa6\x89\xda\xab\x99\x07\xf9\x71\xd4\xdc\xe2\x46\xab\x53\x1a\x03\x2e\x67\x05\x38\xc7\xf2\x69\x76\x59\x01\xe8\x68\xc5\xae\x3e\x9b\x96\x70\x92\xa2\xc6\x12\xf0\x3a\xb5\xe3\x96\xba\x5a\x4e\xad\x00\x78\x95\x05\x12\xde\xc9\xb0\xcd\x30\x7a\xc5\x3d\xf4\xa4\xd6\x44\x01\x90\x01\xea\x31\xa0\xa3\xa6\xd4\x05\xe5\x40\x22\xe6\x98\xb6\x78\x91\xa1\x45\xfe\x9a\xc8\x17\xa2\x8c\x46\x03\x97\x07\x40\x33\xee\xbf\xaa\x29\x75\x41\x2d\x90\x84\x19\x16\x14\x25\x2d\xd3\xb1\xa5\x4e\xaa\x16\x47\x5f\x29\xcf\x42\x40\x13\xa7\x58\x8b\x01\xd5\x72\xea\x82\x72\x20\xe1\x2b\x1d\x52\x6a\x1b\xbb\x0b\x71\x7f\xa8\xcb\x39\xc4\x33\x02\x30\x1e\x0b\x59\xc9\x0c\x59\xa3\xd1\x55\x01\xb0\x8e\xa5\x6e\x9c\x44\xc7\x1b\x3a\x71\x43\x95\x77\x06\xc1\xd2\x09\x40\x9a\x11\x20\x04\x12\x3b\x02\xd4\x00\x90\xda\x66\x14\x2b\xb4\x68\x76\x63\x71\x11\xb6\x04\x87\x02\x40\x47\x02\xdc\xc8\x0c\xd0\x8c\x0c\x03\x19\x1e\x00\x6a\x5d\x9b\x23\x71\x8a\x10\x11\x3a\xe0\x50\x75\xd0\x25\x27\x64\xa4\x13\xd9\x00\x5e\x20\xeb\xa6\x64\xc1\xd6\x2a\xa5\x12\x4b\x51\xeb\xae\x00\x42\x8f\xb7\xc1\xda\xa6\x14\x8c\x95\x42\x49\x41\x21\x90\xec\x88\xba\x07\x4c\x01\xcb\x6a\x37\x06\x8c\x26\x5a\x22\x8c\x01\x29\x03\x8c\x5f\xa0\x16\x4a\x54\x00\x7f\x74\x22\x2b\x38\x76\x6b\x57\xb7\xa5\xca\x33\x31\xb5\xc9\x5d\x27\x70\xa8\x07\xba\x1c\x8c\xf7\x55\x42\xc9\xe1\x01\xbf\x23\x97\x1c\xd3\x11\x01\xd8\xa6\xcf\xf7\x5b\x66\x51\xe6\x49\x6e\x22\x4a\x33\x6e\x52\xba\xdb\xa2\xd4\x0c\xd3\x6b\xb5\xa4\xbf\xa0\x10\xe9\x9e\x6b\xa1\xf4\x82\x51\xb6\xd6\x5a\x4e\xb1\xb7\x6f\xa4\xf7\xed\x28\x5d\x5e\x95\xb2\x05\xb5\x0d\xb1\x82\x5a\x20\xe1\x5a\x4c\x61\xdd\xef\xaf\xd1\x18\xaf\x98\x70\xdd\x2e\x40\x7d\x79\x47\xe7\x5d\x45\x93\x2b\xf5\xd5\x0c\x00\x59\x63\x46\x43\x67\xc4\x75\x4f\xe9\xfa\x34\x2d\x76\x29\x8c\xb4\x99\x28\x2f\xc2\xd6\xf2\x8e\xad\xc1\x4c\xdb\x9c\x90\x66\x22\x33\x17\x70\x0f\x07\xe4\x0c\xcc\xc0\x08\x77\xf6\x6d\x96\xa9\xa4\x74\x50\xda\xf0\x8c\xe7\xb4\xb5\xbc\x0a\xf9\x19\xa3\xc3\x1d\x16\x48\x59\x7f\xfa\xf0\x80\xb8\xc9\xc4\xaf\x69\xe2\x85\xe8\xea\xaa\x96\x52\xe9\xf4\x86\xb6\x34\xc7\x8f\xb7\x28\x4b\xfa\x8b\xe8\x5e\x26\x08\xe1\x2f\x99\x00\x9a\xe2\x58\x02\x42\xd2\xd5\x85\xf7\xe3\xc5\xf9\x1f\x40\xed\x82\x93\x98\x2c\x71\x60\xfd\xf7\x8c\x00\x77\x4c\x27\x0a\x0e\xb4\xb5\x6f\xbf\x07\x4f\xb6\x1f\x96\x80\x0f\x57\x0c\x27\x5e\xaa\xa0\xd4\x17\xb2\x00\xbc\x27\x2e\x80\x22\x43\xbf\xd8\x37\x35\xd3\xd4\x0e\x31\x30\x06\xd3\x95\x96\x1d\x17\x76\x4a\x49\xff\xa1\x01\xe7\xc8\xa5\x48\x3f\x00\x71\x6b\xcb\x31\x0f\x09\x88\x09\x21\x84\x12\x6a\x87\xbf\x60\xaa\x34\xd2\x0b\x87\xd7\xe9\x4b\xb2\x72\xd4\x69\xd2\x80\x07\x49\x0e\x03\x74\xb4\x56\x8b\x3a\xa1\x40\x9a\x8e\xca\xb6\xb6\x82\x50\x87\x5e\xc1\x42\xdd\x1f\xf4\x7d\x2e\xd2\xf5\x08\xad\xcb\xa9\xcf\xa5\xcc\x00\xc3\xac\x1e\x33\xbc\x54\x73\xab\x17\x65\x51\x06\x34\x35\x31\xc5\x45\xe7\x92\x42\x55\x52\x50\x89\x74\x91\x63\xda\xf4\x01\xed\x2d\x79\xbd\xa5\xd0\xd4\x57\x29\x17\xa8\x22\xef\xc0\x5d\xcd\x16\xd0\x31\xe9\x3e\x3f\xfb\x56\xfc\x13\x0f\x11\x9d\x05\xfa\x70\x5f\x5e\x12\xcf\xb3\x29\x9a\xa4\x4b\x98\xfa\xfc\x17\x3c\xb0\x16\xdf\x2b\x2f\xbc\x6a\xc2\xc8\x3d\x4f\xcd\xfe\xea\xba\xc3\x03\x6e\x24\x00\xc9\x16\xd4\x42\x5c\xda\x8a\xbd\xd7\x60\x68\x41\x54\x4d\xba\x4e\xa8\xe9\x48\x80\x57\xb3\x02\x0c\x6b\xdd\x71\x82\x75\x10\x64\x5d\xb6\x7d\x10\xa2\x38\x2f\x83\x7f\x85\x4d\x1f\x6e\x3c\x4c\x58\x30\xa3\x35\x18\x2f\xfa\x9d\x65\xec\x99\xf2\x14\x8f\x65\x60\xc9\x7c\x30\xca\x0a\xf9\xf3\x40\x38\xb1\x95\x07\xa0\x54\x56\x6c\x99\xa2\x0c\x42\x3b\xda\x66\xb7\xc2\x30\x77\x35\x19\x1e\x96\xee\xbb\x3b\x92\x2e\x5d\x52\x38\x48\xa8\x06\x18\x96\x4c\x74\x57\x76\x4a\x9e\xa3\x74\xf9\xae\x29\xe0\xd8\x6f\x3c\x97\xdd\x38\x23\x1d\x5c\x88\x2f\xad\xaf\xda\x3d\x0a\x76\x59\xfa\x1c\x89\x8e\x29\xcd\x3e\x8d\xf2\x19\x73\x2c\xa3\x48\x12\x5d\xdc\x7e\xbe\x4b\x0f\x08\x24\xbd\x3d\xda\xb1\x29\x2c\xda\xc8\xb2\x99\xc4\xe2\xab\x00\x18\xfa\xb0\xfd\x7c\x59\xea\x8a\x8b\xe5\x26\x5b\x2c\xd1\x3f\x62\x91\xa7\xb5\xf1\x3c\xca\xb6\xb2\x01\xe4\xe9\x96\xb8\xde\xd6\x84\x21\x79\x86\x80\x8b\x87\x96\x94\x1e\x07\xdc\xe8\x21\xf9\x82\xe1\xb3\xba\x2b\x93\x74\x0b\x00\xa3\xbe\x82\xbd\x45\x74\xdb\x4c\xc4\x3a\xc7\x71\x4c\xa7\x3b\xe7\xe7\x0f\x32\x40\xf4\x7b\x91\x6a\xec\x28\xf4\x3e\x14\x32\xea\x1f\x6d\x56\xa9\x83\xfe\x39\x5b\x6b\x2c\x72\xb1\x68\x96\xdc\x68\x8f\x0c\xc7\xe4\x07\x15\xc8\xe4\x73\x3c\x3f\x1e\xf3\x8f\x65\x21\x33\x73\xe4\x86\x13\x1a\xc6\xdc\x5d\xb6\xe3\x92\x48\xf8\xaf\xd6\x4d\x17\x8b\x8f\x49\x97\x17\xf8\x91\x1b\xc7\xcc\x48\x66\xae\xa2\xcc\x98\x22\xfa\xcf\xaf\xdb\x07\x56\x72\xd1\x4a\x74\xe4\x35\x4a\x97\xb7\xa2\xdd\xba\x6c\xa6\x38\x96\x19\x74\xc9\x1d\x33\xd5\xe6\x10\x4e\xcb\xfd\x45\x94\x2b\x45\x49\xb0\xe9\xfe\x3a\x15\x0d\x5a\x87\xee\x67\x51\x34\x7d\x87\x5e\xac\xf1\xf0\xca\x57\x7c\x0f\x0b\x16\x7b\xd5\x4c\x7c\x8a\x77\x27\xf4\x68\x3d\x2e\x67\xe3\x24\x3b\xa6\x98\x57\xba\x45\xc6\xe3\x29\x74\xd0\x5e\x4e\x98\xfd\x1d\x20\xd4\xa0\x4c\xe4\x21\xff\xa3\x00\x50\xe5\xe0\x87\x8a\x17\xe3\x96\x0c\x0c\xcd\xdc\x22\xd4\xec\x4a\x4f\x51\x68\xcc\x03\x4b\x4f\xfb\x12\x4b\x36\x50\x3d\x9d\x6c\x00\xd9\xc9\x37\xd1\x32\xa0\xf3\xd4\x7c\x4f\x12\xdd\x3d\xc0\xab\x17\x42\xc7\x77\x32\x2a\xdc\xc1\x49\xb8\x85\x70\x1f\xf1\x00\xc0\xf7\x0c\xfb\xe1\x32\x6b\xcf\xb0\x04\x6d\x27\x8b\x48\x72\x1d\x93\x7c\x71\xb1\x55\xb2\x6b\x50\xf3\xc0\x15\x17\x3d\x14\xc9\x22\xa5\xf5\xc7\x44\x77\xc2\xc0\x9c\x89\x93\x5c\x20\x4c\xfb\x8a\x5c\xc7\x2e\x5b\x56\xdd\x32\x0c\xec\x67\x38\x07\x9e\xd2\xe3\x34\xd4\xb0\xea\x75\xcb\x9a\x8e\x0b\x7f\xa5\x9d\x1c\x85\x0e\xeb\x93\x50\x9c\xc1\x49\x56\x0d\x43\xa7\xba\xc5\x87\x61\xe0\x4f\xc9\xa1\xe3\x83\xe1\xf3\xba\xae\x1b\x2b\x13\x34\x7a\x0f\x16\xc9\x06\x70\x22\xac\x8f\x20\x54\x3d\xd3\x75\x3a\x05\x83\xea\x7c\x84\x30\x7f\xe0\xa7\x3a\xa7\x86\x97\x50\xfc\x80\x57\x01\xec\xe5\x0d\x3b\x14\xee\x05\xf2\x4f\x92\xc5\x1a\x5c\xb3\xf9\xa9\x1e\xc7\x7c\x4e\x1e\x18\x74\x8a\x11\x4e\x4d\xe9\x82\x15\x38\xc0\x6e\x48\x0c\x33\x1f\xd2\xd3\xe8\x89\x31\xc8\x58\xb9\x97\xc3\x04\x5c\x27\x59\x78\x31\x64\x30\xf6\xe4\x8b\xc9\xb6\xbf\xf8\xf8\x0e\x4c\xdb\x54\x34\x68\x8c\x68\x30\xe4\xc8\xb6\x53\x31\xf9\xb3\x89\x4a\xa1\xd0\x7e\x31\x39\x69\x03\x60\x26\x3b\x4d\xe4\xf8\x6a\xd5\x67\x77\x6e\x71\x4f\x12\x0b\xe7\x8e\x4a\x8c\xe2\x27\x83\xa1\x25\xf1\x90\x4f\x37\x6e\x8e\x04\xec\x96\x39\x7e\xa3\xf2\x24\x1b\xc0\xe3\xe4\x6e\x8d\xbd\x4b\xb7\x5c\x0a\x9e\x5a\xba\x8c\x17\x32\x32\x40\xa0\x61\x7c\x54\xb6\xb0\xae\x8f\x17\xf8\xfb\x52\xdd\xe6\x67\x4a\x37\x10\x38\x3c\xe0\xaf\x64\xc4\x0f\xef\xe9\x71\xd6\xe2\x00\x94\xa6\xec\xc8\xd6\xa0\x4e\x65\x3c\xce\x67\x58\x9e\xb8\x87\x85\x77\x32\x23\xc0\x39\xf2\x5b\xd0\x11\x26\xac\x45\x6b\x10\x67\xcf\x88\xcc\xc9\x9d\x24\x81\xc7\x4d\xab\x5b\xd5\x52\x0c\xf8\x7b\x26\x80\xec\x16\x4c\x02\xd0\x03\x40\x2a\x59\x88\x2b\x21\x02\xea\x46\xf7\xe4\xe3\x4b\xea\xbe\x78\x7b\xaf\xe7\x9d\xca\xe8\x48\xc0\xcf\xe4\x2b\x71\x3f\xd3\x72\xc9\x1d\xb5\x52\xb3\x68\x30\x46\xfc\x12\x69\x0e\x8d\x1c\x09\x65\x32\x10\x6f\x3b\xee\x78\x85\xcc\x00\x5f\xe2\x3b\xec\x61\x99\xc3\x95\xaa\x16\x40\x25\x2c\xc5\xb4\x1a\x3e\x0c\x1e\x43\xc2\xe8\x22\x9c\x58\xaf\xb0\xfb\xd6\xb1\x5b\x63\xd6\x32\x02\xfc\x57\x08\x18\x80\x37\xbe\xa8\x0b\xb7\xe5\xc6\x92\x18\x45\xf0\x8b\x27\x9a\x7b\x77\xc5\xc5\x5f\x64\x6b\xb0\xf6\x4a\xe5\x4e\x43\x87\x07\xfc\x9d\x9c\x64\xf7\x28\x28\xfb\x40\xb8\x69\xe9\x3d\x16\x9a\x01\xa1\xce\x08\xd7\xa3\xcc\x47\x2d\x00\xf4\x6a\x1c\x50\xed\x66\x6b\x2a\x0b\xa2\xd0\xc1\x1b\x06\x95\x1b\xb5\x52\x69\xb3\x9e\xf2\x54\x14\x12\x18\xe3\xe3\x48\xde\xa5\x3e\xba\x55\x29\x97\xee\x57\x3d\x6e\xc1\x11\x90\xac\x6c\x00\x5d\xbc\x9b\x73\x70\xe2\x58\xa9\xd4\xfe\x23\xa9\xc4\xc2\x47\xac\xf1\xe9\xf1\xba\x1e\x86\x96\x68\x09\xe8\x4c\x65\x0a\xa7\x9b\x78\xab\x08\xb7\x76\x22\x9b\x1d\xf7\xef\x61\x8a\xf1\x2e\x97\xc1\xab\x8f\xdc\x92\x2f\x01\x0a\x77\x85\xec\xc1\xb2\x1e\x90\x71\x58\x81\x22\x45\x08\x3f\xe0\x05\xf5\x76\xa9\x7c\x8c\x80\x27\x7b\x01\xde\x6d\xe8\x4e\x36\x91\xe4\x44\xcd\x6b\x02\xe0\xc8\x47\x1d\xd7\xb7\xf4\x6e\xb5\x83\x29\x1e\x23\xe3\xe8\xc2\x29\xa1\xd6\x01\xd0\x75\x8f\xbd\xb9\x8f\x0b\xd8\xff\x34\xa3\x48\x42\xc8\xab\x53\x9e\xef\x96\x02\xf2\x91\xd7\x13\x10\xc0\xac\x6b\x60\x41\x16\x5b\x12\x81\x04\x00\x1b\x2e\x58\xf0\x6d\xc9\xf5\xbd\xcd\x13\x4a\x77\x4c\x54\xc9\x66\xc8\xcb\x20\x08\x4a\x9d\xdf\x20\x2f\xb9\xdf\x0d\xa8\xa3\x0a\xae\x90\x31\xf0\x12\x40\xd4\x93\x1e\x54\xdf\x2c\x7b\x5f\x9d\xf0\x4a\xf0\x3f\x68\x8c\x64\xa4\x83\xb0\xb2\x8f\xd7\x02\xbf\xec\x9e\x3a\x51\xf8\xc4\xeb\x02\x44\xb3\x19\x50\x79\x5c\x63\x02\x24\x25\x5b\x62\x8a\x3f\xf1\x4f\x80\x17\xfb\x4d\x5f\xf1\x6e\x48\x2a\x53\xfc\xef\x89\x53\xcd\x5a\xa7\xec\x9f\xfd\xaa\xf0\xa2\x07\xa0\x0e\xe5\xd1\x3c\x99\xb6\x8c\x84\x7a\x0b\x81\xac\xb4\x3f\x3e\xd1\x2e\x77\x6a\x3e\x18\xf0\x9b\xac\x00\xd1\x4d\xfc\x26\x12\x8e\x8d\x1b\x7a\x52\xa9\xd1\x64\xba\x55\x27\x64\x3e\xe5\x22\x42\x85\xac\xf1\x4f\xdb\x65\xd7\xaf\xd5\x3e\x55\xbc\xe1\x9f\xe2\x1b\xff\x7e\xab\xd5\x7c\xaf\xec\x9f\xb2\x12\x39\xff\x14\x0f\xcc\xba\x75\x8b\x90\x8b\xbd\x00\xd1\x84\xb5\x72\xb9\xd6\xa8\x7d\xa6\xf8\x9e\x2b\xc5\x77\x43\x1c\x27\x13\x2f\x1b\x35\xaf\xd3\xa9\x5a\xba\x9e\xe6\x03\x37\x06\x40\x52\x37\xd2\x51\x10\x33\x44\x2b\xc0\x6c\xff\xa4\xfa\x1d\x09\x95\xdf\x84\x4f\x46\x3e\x3b\x7b\xca\xdf\x4e\x01\xf2\x8a\xc9\xba\x09\x46\xbe\xc5\xc3\x34\x4d\x01\xfa\x8d\xb3\x9f\xfe\x46\x54\xed\xa7\xfe\xfe\xe2\xdb\xcc\x05\x7f\xb0\x8c\x9e\x80\xd7\xc8\x1b\xa6\x33\xe9\x25\x88\x41\x10\xdb\x09\xbf\x1f\xcf\xda\x82\x0c\x11\x18\xad\xb4\x93\x30\x3f\x06\x19\xdc\x00\x9d\xc1\x45\x48\x53\x80\xc6\x15\x70\xb2\x5f\x09\xc9\x01\x90\x8d\x7a\xba\xf0\xc0\x25\x88\x32\xf8\x86\xac\xa4\xbd\x84\x55\x51\xc6\xad\xfe\x2e\xd4\x2f\xe0\xad\x6e\x40\x6a\xa0\x0c\xbe\x41\x21\xec\xa1\x40\xc6\xcd\x7c\x01\x1f\x1c\x04\xc8\x74\x26\xa5\x40\xf0\x4a\xdd\x18\x53\x38\xaf\x35\x30\xe0\x4f\x64\xb5\x1b\x10\xd5\x98\xf4\x06\xc4\x27\x2f\xf7\x79\x97\xb0\xbe\x00\xcf\x93\x9b\x86\x9e\xf6\x12\x70\x05\x06\x48\xac\x74\xa6\xa0\xe3\xfa\xbc\xac\x7c\x97\x8f\x01\x00\x2f\x90\x6b\x5d\x80\x30\xc3\xfa\x15\xf6\xec\x15\x23\xd5\x57\xa0\xf8\xe4\x4a\x9e\x80\xdf\xf6\x04\xd4\x23\x40\x23\xa9\xd2\x14\x95\x66\x25\x4f\x27\xf9\x96\xac\x74\x01\x62\x53\xe1\x0a\xf9\x92\x03\xea\xa9\xd6\x1c\x45\x05\xca\xd5\x8b\xa7\x7b\x02\x3e\x23\xd7\xe1\xdf\xb3\x6e\x40\x9d\x3b\x78\x8e\x80\xf3\x56\x0a\x90\x15\x76\xab\x10\x8a\xaf\xb3\xfe\x75\x42\x04\x19\x20\xc9\x17\xf0\x22\x56\x1e\x49\x35\x06\xc0\x5d\x00\x3c\x0f\x80\x7a\xb4\x08\x45\x23\x2e\x7f\x40\x62\x01\x50\x3a\x21\x60\x52\x32\x43\x76\x8d\xb8\x24\x11\xdd\x19\x16\x8a\xf3\x05\xbc\x92\x04\xe4\xad\xfe\xc7\xe0\x3e\xcc\xc3\x13\x80\xcc\x89\x57\xd5\x13\xad\x41\x00\x7f\xc1\x85\x66\xa4\x9b\xa8\x4c\x4a\x12\x1e\x1e\xb5\xfb\xfb\xd6\xe9\xbe\x2d\xb8\x92\xa8\x7d\x79\xc2\x62\x70\x29\x99\xb6\xa4\xfd\x87\x10\x70\x05\xc8\x73\x05\x9c\x4e\xa4\xd4\x14\xf7\x6c\x42\xad\x63\x80\xfa\x94\x94\x56\xeb\xfd\xcb\x60\xff\x77\x70\x4c\x66\x7d\x2c\x9a\x59\x17\x43\x09\xa2\xa9\x8a\xa5\x7f\x19\xec\x1f\xf0\x56\x0f\xc0\x48\x23\xa7\xd2\x0d\x62\x6b\x23\x77\xc0\x6b\x56\xb2\x28\x81\x25\x78\x25\xd2\xc8\xa9\x84\x09\xa9\xd1\xbf\xca\xf4\x0f\x38\x9d\xac\x8d\x70\xbf\xf0\x4a\xa4\x91\x7c\xbb\x29\x6c\x30\xe8\x18\x63\xbe\xcc\x1b\xf0\x62\x12\x10\x03\xc9\x33\xb1\x8b\x79\x25\x55\x35\xc1\x53\x37\xfb\xbe\xa9\x6d\xdf\x80\xf3\x56\xd7\x3e\xc4\xaa\xe8\x9c\x5e\x49\xf5\x07\x0d\xcb\x7a\xdc\xaf\xca\xf4\x0f\xb8\x92\x00\x64\xbd\x2d\x0e\xf8\x13\x06\xe3\xb4\x71\xa7\xf3\x5e\x83\x2c\xa0\x25\xfa\x57\x3a\x15\x65\xc7\x1c\x06\xe3\x54\x63\x33\x7f\xc0\x2f\xa1\xf0\xa4\x89\xdd\x30\x4a\x8d\x6b\x0c\xf0\x02\xb9\x6c\x24\x8d\x6b\xe9\x42\x21\xf3\x15\x6a\x79\xc3\x9a\x57\x96\x3c\xde\xb2\x60\x9c\x74\x91\x61\x00\x5e\xb4\xa4\x4e\x34\xe5\x62\x12\x26\x04\x89\x30\x08\x2f\xa3\xba\xb5\x92\xbf\x93\x24\x7b\xe5\x6c\xc7\x35\x04\xbc\x28\xed\x34\x52\x76\x3c\x84\x15\x03\x79\x87\x3a\x7d\x2a\x41\x38\x25\x99\x49\xda\xac\xd5\xd9\xc6\x93\xd1\xff\x1c\xf7\x1f\xea\x0c\x3e\x7d\x61\xb8\xa0\xd8\xdb\x0a\xe1\x23\x09\x12\xfb\xdb\x34\xff\x74\x0b\x93\x2a\xd6\xdb\x8d\x4c\x65\x85\x29\xd5\xb7\xa2\x03\x17\x6a\xa0\xc1\x25\x68\x26\x67\xc0\x8d\x3f\x0c\xb1\xc2\xa2\x70\x21\xc1\x8b\x56\xbf\xd8\x8a\x97\xad\x9b\x1b\x20\x79\x60\x51\xe9\xf8\x09\xf0\xad\x46\xef\xd8\xbc\x68\x59\x3c\x61\x10\x5b\xb3\x60\xdd\xfc\xf3\x41\x02\x10\x52\x65\x0e\x3f\x49\x46\xaa\x03\x2f\xe5\x87\x53\xf8\x93\xb7\xf2\x17\xea\x15\x4b\xf2\x61\x40\x48\x38\xaa\xc5\x0e\x57\x88\x8c\x06\x37\x92\x6f\xe6\x0f\x88\x19\x75\xe8\xab\xfc\xb4\x42\x22\xd3\x91\x0a\x26\xdc\xe8\xce\xdf\x82\x58\x19\x19\xe2\x8c\x07\x66\x03\xba\x6c\xc1\x8b\x1c\x90\x6f\x23\xf3\xcd\xf8\x9c\xd7\x20\x24\x04\xe2\x0c\x00\x6a\x32\x5b\x69\xba\xcc\xc0\x1e\x8d\xce\x7e\xa0\xb3\x5f\xce\x57\x07\xe7\xc8\x2a\x15\xa7\x00\xf8\x52\x43\x40\x69\x0d\x3e\x43\x1f\xe1\x1a\x88\x07\x55\x40\x67\x72\x6e\x7d\xfc\x42\xc6\xa2\x03\x5a\x68\x49\x60\xb0\x1e\x24\x16\x80\xa4\x33\xfc\x34\x43\xbe\x80\x98\xaf\xf2\xf3\x08\xec\xa8\x0c\x36\x8e\xac\x6b\xf2\x0b\xea\x9c\x90\x1f\xea\x19\x28\xe1\xea\xbb\xf5\x61\x89\xbe\x9f\xc1\xf6\x9c\x0c\x2b\xd9\x3b\xb8\x66\x44\x47\x17\x18\x63\xfe\x80\xd3\x78\xf9\xe8\xe0\x1b\x48\x49\x3d\xfd\x34\xda\x36\x3a\x43\x33\x2c\x40\xb1\xad\xae\x83\x4c\x77\x01\x32\x37\xd6\xc5\x11\x9a\xdc\x5b\xc0\x62\x8a\xe3\xe3\x14\xa9\x16\xea\x34\x0b\x75\x06\x0b\x36\xc8\x67\xe4\x6c\xc1\x6f\xc9\x63\xf9\x54\x23\x53\x93\xf9\x64\x77\x2e\xf4\x62\xf1\x65\x08\x80\xe1\xc9\x27\x91\xd4\xcb\x4e\x72\x1e\x0a\x3b\xee\x22\x7c\x1b\x07\x9d\x24\xdf\x6d\x88\x0b\x12\x20\xd7\xea\x14\xe0\xae\x58\x7f\xbc\x49\x83\x52\x93\x37\xe0\xe5\x70\x8a\x45\x17\x3a\x01\xf8\x0b\xee\xe5\x49\xe5\xc0\xb0\x00\xa5\x26\x6a\xba\x87\x8a\x9b\x8d\x46\x74\x0c\x6e\xa8\x80\x51\xfb\x60\x3e\x05\x18\xb5\x08\xe9\x10\x2c\xc8\x5b\xf9\xf1\x89\x0a\x6a\x74\x01\xd2\x29\xa9\x93\x9e\xbb\x93\x24\x01\x59\x48\x91\x01\x79\x83\x2b\x7c\xc3\x04\x07\xcc\x5d\xa8\x0d\xe9\x80\x23\xed\x02\xe4\x53\x1c\xbd\x17\x62\x18\xb1\xd8\x88\x27\x10\x23\x45\xb7\x05\x69\x78\x8a\x1a\xf9\x87\x11\x8b\xc3\xad\x10\x3a\xd5\x05\x88\x5b\xb2\x7a\x78\x88\x55\x18\x38\x6f\xc0\x8b\xc9\x0e\x56\x72\x91\xb1\x1d\x4f\x1a\x1d\xb4\xa6\xba\x91\xff\x6e\x67\x0c\xc8\xf6\x0a\x93\x32\x83\x87\x2e\x0c\x01\xc8\xdf\xe0\xa4\xe7\xbe\xdb\x49\x64\x40\x96\x51\x5f\x94\x23\xc9\x65\xcc\x12\xc4\x0c\xb3\x58\x9c\x3f\xe0\x15\xf6\xd6\x25\xf1\x0e\x30\x3c\x7c\x99\x28\x59\xae\xc9\xef\x13\x43\x9d\xce\x79\x3b\x16\xc6\x9b\x99\x99\xff\xc2\xf8\x3b\x7c\xcc\xc0\xb7\x33\x6f\x12\xcf\x4e\xc0\x63\x7f\x87\xe7\xfe\x0f\x5f\x00\xdf\xa7\x9e\xce\xa5\x37\x93\xd3\xf8\x0b\xf0\x2f\xc0\x61\x8f\xff\x01\x92\x6b\x7c\x47\xa0\x73\x59\x6e\x00\x00\x00\x00\x49\x45\x4e\x44\xae\x42\x60\x82');
    }
    return getPortraitPreviewBitmap.image;
}

// Cached grayscale palette with reduced alpha for the inactive controls.
function getDisabledPortraitPreviewBitmap() {
    if (!getDisabledPortraitPreviewBitmap.image) {
        getDisabledPortraitPreviewBitmap.image = ScriptUI.newImage('\x89\x50\x4e\x47\x0d\x0a\x1a\x0a\x00\x00\x00\x0d\x49\x48\x44\x52\x00\x00\x00\xa0\x00\x00\x00\xf0\x08\x03\x00\x00\x00\xb0\x9f\x9f\xe8\x00\x00\x01\x80\x50\x4c\x54\x45\x77\x77\x77\x35\x35\x35\x36\x36\x36\x72\x72\x72\x22\x22\x22\x1d\x1d\x1d\x21\x21\x21\x68\x68\x68\x61\x61\x61\x3f\x3f\x3f\x60\x60\x60\x61\x61\x61\x26\x26\x26\x8e\x8e\x8e\x52\x52\x52\x5e\x5e\x5e\x8b\x8b\x8b\x6f\x6f\x6f\xae\xae\xae\xce\xce\xce\x40\x40\x40\x42\x42\x42\x50\x50\x50\xb2\xb2\xb2\xf0\xf0\xf0\x33\x33\x33\x1d\x1d\x1d\xb3\xb3\xb3\x58\x58\x58\xa0\xa0\xa0\xe2\xe2\xe2\x44\x44\x44\xad\xad\xad\xba\xba\xba\x00\x00\x00\x61\x61\x61\x67\x67\x67\x46\x46\x46\x41\x41\x41\x3b\x3b\x3b\xc4\xc4\xc4\x33\x33\x33\x53\x53\x53\x29\x29\x29\x4c\x4c\x4c\xba\xba\xba\x3d\x3d\x3d\x57\x57\x57\xb3\xb3\xb3\xa6\xa6\xa6\x4e\x4e\x4e\x85\x85\x85\x9a\x9a\x9a\x79\x79\x79\x22\x22\x22\x3c\x3c\x3c\x64\x64\x64\x14\x14\x14\x3b\x3b\x3b\x31\x31\x31\x55\x55\x55\x92\x92\x92\x12\x12\x12\x2d\x2d\x2d\x6f\x6f\x6f\xcd\xcd\xcd\x3c\x3c\x3c\x5b\x5b\x5b\x2b\x2b\x2b\x22\x22\x22\x2c\x2c\x2c\x0c\x0c\x0c\x18\x18\x18\x21\x21\x21\x19\x19\x19\xac\xac\xac\x1e\x1e\x1e\x2c\x2c\x2c\x12\x12\x12\x66\x66\x66\x2f\x2f\x2f\x35\x35\x35\x46\x46\x46\x07\x07\x07\x1d\x1d\x1d\x24\x24\x24\x7f\x7f\x7f\x6e\x6e\x6e\x2d\x2d\x2d\xff\xff\xff\x19\x19\x19\x21\x21\x21\x59\x59\x59\x39\x39\x39\x8c\x8c\x8c\x22\x22\x22\x3d\x3d\x3d\x1e\x1e\x1e\x1e\x1e\x1e\x26\x26\x26\x4c\x4c\x4c\x20\x20\x20\x26\x26\x26\x33\x33\x33\x35\x35\x35\x90\x90\x90\x0e\x0e\x0e\x22\x22\x22\x2f\x2f\x2f\x29\x29\x29\x4e\x4e\x4e\x0a\x0a\x0a\x1b\x1b\x1b\x2b\x2b\x2b\x21\x21\x21\x22\x22\x22\x35\x35\x35\x4b\x4b\x4b\x5d\x5d\x5d\x63\x63\x63\x1e\x1e\x1e\x27\x27\x27\x25\x25\x25\x51\x51\x51\x8e\x8e\x8e\xa5\xa5\xa5\x1c\x1c\x1c\x13\x13\x13\x18\x00\x4f\x62\x00\x00\x00\x80\x74\x52\x4e\x53\x6c\x14\x7a\x4e\x4e\x72\x11\x08\x7e\x2c\x55\x6e\x33\x7e\x69\x34\x02\x36\x7e\x7e\x0c\x53\x4e\x7e\x01\x64\x00\x00\x31\x02\x00\x0a\x7e\x02\x00\x7e\x7e\x7e\x7e\x7e\x7e\x7e\x7e\x7e\x7e\x7e\x7e\x7e\x7e\x7e\x7e\x7e\x7e\x7e\x7c\x02\x7c\x26\x04\x7e\x02\x7e\x18\x7c\x7e\x7e\x67\x7e\x7c\x28\x02\x16\x38\x57\x02\x7e\x1a\x38\x0a\x7e\x58\x58\x7e\x02\x48\x69\x01\x02\x46\x00\x46\x48\x01\x58\x7e\x38\x0b\x58\x66\x01\x00\x16\x26\x46\x4b\x7d\x01\x66\x68\x67\x02\x02\x3a\x2c\x26\x5c\x68\x02\x7e\x48\x08\x56\x05\x26\x7c\x01\x7d\x0a\xf1\x26\x49\xa0\x00\x00\x15\xe0\x49\x44\x41\x54\x78\xda\xed\x9c\xf9\x63\xd3\x46\xda\xc7\x9d\x90\x84\x70\x76\x4b\xb7\xed\xb6\xdb\xdd\xf7\xdd\x91\x33\xb2\x0e\x5b\x92\x25\x1b\xe7\x70\xec\xe6\x80\xa4\xce\x45\x0a\x6d\x20\x90\x2c\x57\x29\x05\x5a\xae\x72\x95\x96\x7f\x7d\x9f\x67\x66\x24\x8d\x64\x87\x66\x6c\x24\xe7\x87\x0e\xcd\x65\x3b\xd5\x27\xcf\xcc\xf3\x7d\x8e\x19\xab\x40\x8e\xf8\x28\xfc\x05\xf8\x17\xa0\xc2\xf8\x86\x8d\x23\x0a\x28\x83\x7d\x48\xc8\x0f\x04\xc8\x88\xee\xde\x7d\x7a\xfa\x87\xa7\x3f\xdc\x8d\x1e\x38\x52\x16\x7c\x3a\xf6\x68\x69\x69\x76\x16\xff\x7b\x34\xf6\xf4\xd5\x11\xb3\xe0\xc6\xe9\x47\xb3\xb3\xa3\xa3\xb3\xb3\x8c\x10\x3e\x2d\x9d\xde\x38\x4a\x80\x4f\x1f\xcd\x56\xc4\x40\x38\x6e\xc6\xa7\x47\x07\x70\x6c\x09\xf9\xb6\x23\x46\xfc\x58\x5a\x5a\x1a\xdb\x38\x1a\x80\xaf\x5e\x0b\xf3\x21\xe1\x76\x55\x40\x02\xe0\xec\xeb\xa3\x00\xf8\xcd\xcc\xeb\x51\x86\x55\x65\xa3\x12\x4f\x35\xfc\xf7\xfa\xdd\x9d\x61\x03\x7e\x43\x4e\x33\xbb\x55\x17\x17\xab\xf1\x10\x90\xa3\x95\xd7\xe4\xf6\x70\x01\x6f\x93\x09\x98\xdf\xea\xe2\x66\x1b\x06\x7c\xda\x5c\x4c\xda\xb1\x72\x7a\x60\x41\x1c\xd0\x82\xbf\x3e\xaa\xa0\xf5\x70\x54\xab\x8d\xcd\x45\xf8\xb7\x59\x5d\xac\xe2\x83\xc0\xb9\x5d\x79\x34\xec\x29\xbe\x5b\x91\xa7\xb5\x5a\xdd\xe6\xdf\x57\xab\x9b\x60\xcd\xc5\xea\x76\xe5\x87\x41\x4d\x58\x18\x6c\x05\xbe\xae\xc4\x53\x3a\x5a\x65\x8c\x8d\x76\xc3\xf7\xdb\x68\xd6\x36\x98\x72\xe0\x55\x38\x98\x05\x37\x46\xb7\x39\x5f\xe3\xad\xe7\x95\x5d\x0f\x3e\x95\x4b\x38\xce\x35\x98\xe7\x54\xb7\x47\x87\x3b\xc5\x77\x67\xb7\x91\xaf\x11\x00\xd3\xd7\x38\x3e\xf9\xfa\x6b\x06\x58\xf2\xda\x48\x58\xdd\x9e\xbd\x3b\x44\xc0\xdb\xe4\xee\x28\xe3\xf3\x38\x94\x60\xe3\xc3\x7d\x3b\x5a\x81\x25\x39\x3b\x31\xe0\x22\x2c\x0c\xb4\x04\x27\x50\xa4\x17\x03\x97\xcd\x2b\x5a\x30\xe2\x2b\x97\x5d\x1f\x9d\x66\x60\x2f\x19\x0c\xf0\x07\x14\xe9\x4d\x4f\x00\x96\x24\xc0\x12\xac\x48\x54\x9a\x61\x03\xa2\x4c\xb7\x3d\xb7\xd4\x35\xc0\x82\x5e\x03\xa3\xf3\x70\x01\x9f\x02\xe0\x68\x5b\x58\xb0\x0b\x70\xb1\x32\x64\x40\xf0\xe2\x25\x40\x88\x01\xe5\x29\x06\xcd\x69\x60\xd2\x70\x77\xa8\x32\xf3\x6a\x69\xb4\x32\xea\x77\x5c\xd9\x45\xc2\x6f\x5c\xd7\x07\xfb\x2e\x0d\x17\x70\x02\x2c\xb8\xed\xb9\xee\xfd\x76\xbb\xd1\xf0\xcf\x09\x09\xf4\x37\x17\x1b\xed\xb7\xe7\x3a\x01\xcc\xff\xa3\x57\x43\x05\xfc\xfe\x51\x65\x76\xb1\xe3\xd5\x7c\xcf\x7b\xeb\xfb\x6f\xd9\x4c\x97\x7d\xdf\xbf\xef\x79\x7e\x2d\xf0\xc0\x89\x47\xbf\x1f\x26\xe0\x37\x64\xac\xb2\xd4\xe8\x04\x1e\x6a\x8c\xeb\x7a\x0c\xf0\x1c\x58\x94\x19\x12\x00\x67\x2b\x63\xe4\xdd\xf0\x00\xef\x90\x8f\x4f\x2d\x2d\x35\x00\xcc\x85\x59\xdd\x04\x33\x22\x61\x10\xd4\x20\x53\xa8\x41\x5c\xf6\x16\x97\x96\x0a\x1f\x93\x3b\xc3\x02\xfc\x9e\xfc\xb6\x57\x6e\x2f\xb5\xdd\x73\xde\xe6\x94\x65\x2d\xb5\x3d\x10\xc4\xaf\x5d\x2f\x98\xac\x58\x4b\x2f\x36\xe1\xa7\xc6\xb8\x5f\xf2\x8f\x93\xb9\x21\x01\xfe\x8d\x1c\x3b\x55\x2b\x57\xda\x6e\xd9\x6b\xff\x7f\x7b\xf4\xc5\x27\x60\x49\x70\xde\x72\xf0\x49\x7b\xfc\xc5\xe7\x35\xb7\xec\x56\xab\x6e\x0d\x4c\xf8\xb7\xe1\x01\xee\xed\xed\xd5\x1a\xa8\x82\xae\x77\xdf\x43\x75\xe6\x1f\x9f\x07\x18\x5c\xca\x2e\x24\x86\x7b\xb5\x63\x43\x05\x2c\x07\x05\x3f\x15\x47\xa2\x9f\xca\x9d\x5a\xad\xe9\xed\x0d\xcf\x82\xc7\xc9\xc7\x41\xa7\xd6\x68\x7a\xe5\x9e\x7c\xa5\xb2\xd7\x2c\xd4\x3a\xcd\x8f\xc8\xcf\x43\x02\xbc\x4d\x46\x02\x0f\xd4\x2e\x90\x98\x4a\x65\xe9\x07\x78\x6a\xcf\xf3\x47\x06\x4b\xfa\x07\x91\x99\x7f\x90\x63\x6e\xe0\x07\x81\x1b\x67\x08\xb8\xf2\x62\xc0\x66\x2d\x70\x8f\xc1\xcb\x86\x05\x08\x3a\x13\xb8\x41\xad\x19\x2d\x42\x94\x6a\xaf\x13\x66\xd6\xf0\x54\xd0\x09\x06\x54\x99\xc1\x22\xc9\xef\x60\x42\x10\xe9\x68\x11\x36\x37\x9b\xcd\x86\x2f\x00\x61\x09\x96\xcb\x9d\x63\x64\xc0\x58\x37\x58\x2c\xfe\x07\x29\x60\xe8\x88\x13\x56\x69\x41\x96\x03\xbf\x54\x2a\x90\x7f\x0d\x35\x59\x38\x4e\xde\x15\xbc\xcd\x66\xe4\x19\x89\x94\xbf\xd9\x08\x0a\x23\xf0\x92\xa1\x76\x16\x20\xce\x8e\xbc\x2b\xb8\x61\x51\x22\x65\xad\x30\xf5\x23\x23\x47\xa0\xfd\x86\x99\xc0\xb1\x0e\x0b\x26\x7e\xb0\xe7\x43\x64\xf1\x03\x9f\x05\x14\xf0\x5f\x42\x86\xde\x7e\x83\xf1\xf3\x9d\x91\x26\xd7\x96\x4e\x10\x74\xbc\x20\xf0\xb8\xe2\x34\x47\xee\xfc\x7c\x04\x2c\xc8\xd4\xe6\xa5\x98\x63\xb4\x9b\x2b\xbe\xe9\x9c\x04\x27\x3f\x1a\x80\x00\x12\xae\xc2\xb2\x27\x0a\x28\xb7\x53\x78\x77\xf5\xf6\x51\x01\xbc\x4d\xde\x35\x12\xa5\x27\xd6\xc4\x23\xe4\x83\xf0\x7d\x98\x6d\x88\xef\xc9\x67\x35\x4f\x4e\x18\x82\xc6\xd9\xdf\xff\x4d\x8e\x10\xe0\x9d\x97\x7e\xc3\x8f\x4c\xe8\xfa\x8d\xda\x29\x72\xf5\x08\x01\x1e\x27\x2f\x03\xbf\xd1\xe6\x51\xa4\x1c\x6c\x36\xfc\xe6\xc9\x41\x43\xdc\x07\x05\xfc\x99\x7c\xd4\x09\xfc\x5a\xa3\xe6\x43\xf1\xd9\x6e\xd4\xf6\x7c\xef\xd8\xc0\x31\xee\x43\x03\x96\x9a\x3e\x20\xc2\xa8\xf9\xcd\xa6\x07\x2a\xfd\x9f\xa3\x06\x58\x0a\xf6\xf6\xa0\x66\x07\x3c\xc8\xb1\x07\x4e\x03\x3f\xf0\x1a\xbc\xfa\x12\xf5\xd9\x6b\xf2\xe1\x81\x5e\x17\x8e\x90\x93\x9c\x07\x96\x02\x4b\x68\xce\x05\x80\x17\xb8\x65\x6c\xaf\x8e\x90\x5f\xcf\x1f\x0d\x40\xc4\x38\xd1\x14\xa1\x0e\x23\x09\x26\x0e\xae\x77\x32\x7c\x6e\xc8\x80\x80\x70\x7a\x6b\xb4\x99\x88\x23\x08\xe8\x7a\x67\x1f\xdc\x23\xe4\xfa\x90\x01\xd1\x42\x3b\xf6\x64\x50\x8e\x8b\x39\x5e\xbc\x43\xd2\xe0\xbe\x30\x17\x96\x09\x99\x3b\x3f\x3c\xc0\x0b\xf0\xb1\x4e\x4d\xcd\xbc\x2f\x57\xc3\xbc\xf4\x2c\x97\x5c\x4d\xd3\xe8\xa5\x35\x42\xbe\x3b\x3f\x1c\x40\x2c\xd6\x9e\x2c\xd8\x1a\x8e\x33\x61\xc9\x5e\xe6\x70\xf8\xdd\xa4\x56\x0c\x11\xaf\xce\xe4\x0e\xf8\x13\xe2\xad\x2f\x98\x1a\xa3\x28\x3a\x93\x9f\x4b\x6d\x05\xfc\x7c\x1f\xf8\x8a\x0c\xde\xbe\xb1\x2c\xfe\x9c\x1c\x01\xbf\x23\x64\xfe\x1e\x4c\x2e\x0e\xc0\x40\x94\xc9\x33\xac\x28\x61\x05\xc9\xe7\x67\x26\x9d\x90\x0f\x86\xb9\xb0\xbe\xd1\x37\x62\xa1\x3f\xd7\x58\xbb\x61\x73\xb2\x22\x07\x61\x9f\x26\xcf\x9c\xb9\x0f\xff\xce\x4c\x6a\x0e\x7b\x46\xc3\x27\xd9\xd0\xec\x7b\xf3\x7d\x8a\x4e\x1f\x80\xff\xe4\x78\xd2\x60\x84\xec\x8b\xa3\x39\x8e\x16\x1a\x2f\xf1\x12\xfb\xc7\xfe\x08\xfb\xb1\xe0\x7a\x12\x8f\x1b\x2b\x05\x2c\x99\x2f\x1c\x74\xb9\x1f\x59\x54\x06\xbc\x4e\x6e\xa4\xaf\x5c\x2c\x6a\x11\x56\x34\xe2\x67\xa2\x97\x9b\xeb\x39\x58\x70\x8e\xdc\xeb\xe6\x93\x0d\x17\xf1\x69\x69\xb3\x16\x8b\xf6\xb2\xfa\x2c\xab\x4f\x31\x2d\x1e\x3c\x22\x38\xf1\x7d\x72\x15\x68\xe6\x25\x75\x5f\x2e\xa8\x06\x8f\x65\x53\xeb\x5e\x74\xd1\x34\xa7\x1e\x09\xbd\xa7\x28\xb4\x88\x6e\x64\x3d\xc5\xdf\x91\x1b\xe2\x5a\xc5\x43\x0c\x2d\x7e\x1d\xff\x25\xf3\x09\x8b\x8f\x99\x4e\x31\x2d\xf6\x5a\x60\xef\x99\x73\xfe\xd5\xc4\x19\xd6\xb4\x1f\x95\xe7\xb8\xa0\x28\xd1\x6b\x36\xd3\x0f\xcd\x3c\x1c\x60\x24\x39\x66\xb1\x08\x02\xa9\x2d\x64\x3c\xc5\x33\x64\x9d\xc7\xb6\xc3\x01\x6a\x62\x1d\x6a\x45\x7c\x39\x46\x46\x7b\x3e\x5b\xc0\x39\x10\x41\x6e\x0e\xd3\x3c\xc4\xc4\xc6\xca\x63\xb3\xdf\x82\x38\xa3\x2c\x34\xaa\x6b\x70\xa1\xc8\x2f\x67\xda\xbd\xfc\xf6\x40\x6d\xb4\x99\x11\xc1\x86\xeb\x64\x26\x5b\x40\x1b\x2f\x09\xe6\x63\x80\xda\xe1\x1c\x19\x3e\x28\xa3\x33\x8b\x9a\xb2\x12\x16\xd4\xc2\xdc\x9a\x2d\x56\x20\x07\xd4\x0e\x61\x45\xe6\xf4\x54\xd3\x38\xe0\x42\xa6\x6b\xf0\x02\x79\xe2\x30\x40\xc8\xa3\xa9\x76\xb8\x39\x0e\x01\x4d\x9b\x01\xd2\x4c\x01\x67\xc8\x69\xa0\x73\xc0\x43\x4c\x06\x78\x58\x99\x91\x01\xd7\xb2\x04\x9c\x23\x3f\x22\xa0\xe6\x98\xb6\x4d\x0f\x31\xbd\x9a\x88\xc9\xc0\x65\xdb\x36\xd3\x1a\xe5\x7c\xa1\xa0\x18\xe8\x18\xa0\x06\x7c\x54\xfb\x73\x27\x09\xb3\x30\x06\x68\x72\xad\x59\x57\x0c\x76\x8a\x5e\xbc\xc0\xe3\x30\x3d\x1c\x20\xcf\x61\x50\xa7\x75\xb0\x38\x03\x74\xee\x29\xea\x8c\x22\x20\xe5\x17\x05\x3e\xe3\x60\xc0\xae\xf4\xba\x68\xb6\x28\x85\x95\x8b\xeb\x71\x4c\x51\x67\xd4\x00\xe7\x6d\x51\x7a\x50\xda\xd2\xba\x0b\x8f\x9e\xa0\xf8\x1a\xbb\x45\xcd\xa2\x6d\xe2\xf7\x37\xb0\x24\xcc\x08\x10\x53\x05\x71\xc5\x08\x30\x54\xe3\x94\xac\x88\x9c\x35\x24\xb4\x5b\x3a\x9b\xe1\xa2\x7a\xba\xa0\x06\xf8\xc4\x0c\x01\x75\x3d\xb6\xa0\xd6\x9d\x52\xcb\x61\x86\x01\x52\x9e\x71\xa9\xe7\xac\x05\x25\x19\x5c\x77\xc2\x55\x6f\xe8\x5a\xb2\x7a\x0b\x73\xe7\x70\x69\x46\xb9\x34\xa3\xaa\x83\xc8\x38\x1c\x70\x2d\x4b\xc0\x7b\xbc\x93\x00\x43\x6f\x99\x72\x01\xd7\x95\xc3\x46\x95\x72\x11\x75\x89\xd6\x35\x96\xa0\xa1\x31\x15\x85\xb0\xa0\xa8\xd3\x02\xb0\x48\xeb\x66\x5c\xbe\x1d\x50\x94\x68\x31\x60\x2b\x06\x7c\x92\x1d\x20\xea\x74\xd8\x36\xb0\xeb\xe6\x21\xbc\x98\xff\x0d\x00\xa8\x43\x06\xc4\x7f\x34\x15\x13\xae\x82\xa2\x4e\x87\x26\x34\x5b\xb6\x16\x2d\xc1\xf7\x56\xca\x98\xeb\xeb\x34\x06\xdc\xc9\x12\x90\x86\x73\x16\x03\xf6\xb2\xa2\x16\x89\x38\xb7\xa0\x09\x80\xa0\x82\xec\x27\x47\x31\x23\x54\x02\xdc\xa0\x61\x41\xa2\x69\x31\x60\xf7\x02\xd4\x22\x09\x62\x9f\x1d\x5b\xa7\x8e\x2d\x1e\x73\x16\xd4\x36\x28\x14\x00\x7f\x62\x3a\xad\x89\xf2\xa7\x45\x7b\x4d\x71\xb2\x18\x09\xdd\xd8\x36\xa8\x19\x02\xaa\x2a\x75\x41\x45\xa7\x97\x4d\x7e\x45\x90\x34\x47\xa7\x6c\xf9\xff\x49\xe1\xc4\xff\x04\x8c\x74\x66\x08\xa8\xa8\xd4\x0a\x80\x17\x30\x90\x44\x73\x1c\x03\xf6\xf2\x64\x4d\x5e\x83\xa0\x32\xd4\x8e\x64\x93\xce\x67\x05\x88\x81\x24\x34\x09\xa4\x0b\xba\xa6\x69\xe6\x01\x19\x43\xaa\xee\x04\x0b\xc6\x2e\x65\xaf\x29\x09\x61\x41\x2d\x90\x84\x80\xa6\x89\xda\xab\x99\x07\xf9\x71\xd4\xdc\xe2\x46\xab\x53\x1a\x03\x2e\x67\x05\x38\xc7\xf2\x69\x76\x59\x01\xe8\x68\xc5\xae\x3e\x9b\x96\x70\x92\xa2\xc6\x12\xf0\x3a\xb5\xe3\x96\xba\x5a\x4e\xad\x00\x78\x95\x05\x12\xde\xc9\xb0\xcd\x30\x7a\xc5\x3d\xf4\xa4\xd6\x44\x01\x90\x01\xea\x31\xa0\xa3\xa6\xd4\x05\xe5\x40\x22\xe6\x98\xb6\x78\x91\xa1\x45\xfe\x9a\xc8\x17\xa2\x8c\x46\x03\x97\x07\x40\x33\xee\xbf\xaa\x29\x75\x41\x2d\x90\x84\x19\x16\x14\x25\x2d\xd3\xb1\xa5\x4e\xaa\x16\x47\x5f\x29\xcf\x42\x40\x13\xa7\x58\x8b\x01\xd5\x72\xea\x82\x72\x20\xe1\x2b\x1d\x52\x6a\x1b\xbb\x0b\x71\x7f\xa8\xcb\x39\xc4\x33\x02\x30\x1e\x0b\x59\xc9\x0c\x59\xa3\xd1\x55\x01\xb0\x8e\xa5\x6e\x9c\x44\xc7\x1b\x3a\x71\x43\x95\x77\x06\xc1\xd2\x09\x40\x9a\x11\x20\x04\x12\x3b\x02\xd4\x00\x90\xda\x66\x14\x2b\xb4\x68\x76\x63\x71\x11\xb6\x04\x87\x02\x40\x47\x02\xdc\xc8\x0c\xd0\x8c\x0c\x03\x19\x1e\x00\x6a\x5d\x9b\x23\x71\x8a\x10\x11\x3a\xe0\x50\x75\xd0\x25\x27\x64\xa4\x13\xd9\x00\x5e\x20\xeb\xa6\x64\xc1\xd6\x2a\xa5\x12\x4b\x51\xeb\xae\x00\x42\x8f\xb7\xc1\xda\xa6\x14\x8c\x95\x42\x49\x41\x21\x90\xec\x88\xba\x07\x4c\x01\xcb\x6a\x37\x06\x8c\x26\x5a\x22\x8c\x01\x29\x03\x8c\x5f\xa0\x16\x4a\x54\x00\x7f\x74\x22\x2b\x38\x76\x6b\x57\xb7\xa5\xca\x33\x31\xb5\xc9\x5d\x27\x70\xa8\x07\xba\x1c\x8c\xf7\x55\x42\xc9\xe1\x01\xbf\x23\x97\x1c\xd3\x11\x01\xd8\xa6\xcf\xf7\x5b\x66\x51\xe6\x49\x6e\x22\x4a\x33\x6e\x52\xba\xdb\xa2\xd4\x0c\xd3\x6b\xb5\xa4\xbf\xa0\x10\xe9\x9e\x6b\xa1\xf4\x82\x51\xb6\xd6\x5a\x4e\xb1\xb7\x6f\xa4\xf7\xed\x28\x5d\x5e\x95\xb2\x05\xb5\x0d\xb1\x82\x5a\x20\xe1\x5a\x4c\x61\xdd\xef\xaf\xd1\x18\xaf\x98\x70\xdd\x2e\x40\x7d\x79\x47\xe7\x5d\x45\x93\x2b\xf5\xd5\x0c\x00\x59\x63\x46\x43\x67\xc4\x75\x4f\xe9\xfa\x34\x2d\x76\x29\x8c\xb4\x99\x28\x2f\xc2\xd6\xf2\x8e\xad\xc1\x4c\xdb\x9c\x90\x66\x22\x33\x17\x70\x0f\x07\xe4\x0c\xcc\xc0\x08\x77\xf6\x6d\x96\xa9\xa4\x74\x50\xda\xf0\x8c\xe7\xb4\xb5\xbc\x0a\xf9\x19\xa3\xc3\x1d\x16\x48\x59\x7f\xfa\xf0\x80\xb8\xc9\xc4\xaf\x69\xe2\x85\xe8\xea\xaa\x96\x52\xe9\xf4\x86\xb6\x34\xc7\x8f\xb7\x28\x4b\xfa\x8b\xe8\x5e\x26\x08\xe1\x2f\x99\x00\x9a\xe2\x58\x02\x42\xd2\xd5\x85\xf7\xe3\xc5\xf9\x1f\x40\xed\x82\x93\x98\x2c\x71\x60\xfd\xf7\x8c\x00\x77\x4c\x27\x0a\x0e\xb4\xb5\x6f\xbf\x07\x4f\xb6\x1f\x96\x80\x0f\x57\x0c\x27\x5e\xaa\xa0\xd4\x17\xb2\x00\xbc\x27\x2e\x80\x22\x43\xbf\xd8\x37\x35\xd3\xd4\x0e\x31\x30\x06\xd3\x95\x96\x1d\x17\x76\x4a\x49\xff\xa1\x01\xe7\xc8\xa5\x48\x3f\x00\x71\x6b\xcb\x31\x0f\x09\x88\x09\x21\x84\x12\x6a\x87\xbf\x60\xaa\x34\xd2\x0b\x87\xd7\xe9\x4b\xb2\x72\xd4\x69\xd2\x80\x07\x49\x0e\x03\x74\xb4\x56\x8b\x3a\xa1\x40\x9a\x8e\xca\xb6\xb6\x82\x50\x87\x5e\xc1\x42\xdd\x1f\xf4\x7d\x2e\xd2\xf5\x08\xad\xcb\xa9\xcf\xa5\xcc\x00\xc3\xac\x1e\x33\xbc\x54\x73\xab\x17\x65\x51\x06\x34\x35\x31\xc5\x45\xe7\x92\x42\x55\x52\x50\x89\x74\x91\x63\xda\xf4\x01\xed\x2d\x79\xbd\xa5\xd0\xd4\x57\x29\x17\xa8\x22\xef\xc0\x5d\xcd\x16\xd0\x31\xe9\x3e\x3f\xfb\x56\xfc\x13\x0f\x11\x9d\x05\xfa\x70\x5f\x5e\x12\xcf\xb3\x29\x9a\xa4\x4b\x98\xfa\xfc\x17\x3c\xb0\x16\xdf\x2b\x2f\xbc\x6a\xc2\xc8\x3d\x4f\xcd\xfe\xea\xba\xc3\x03\x6e\x24\x00\xc9\x16\xd4\x42\x5c\xda\x8a\xbd\xd7\x60\x68\x41\x54\x4d\xba\x4e\xa8\xe9\x48\x80\x57\xb3\x02\x0c\x6b\xdd\x71\x82\x75\x10\x64\x5d\xb6\x7d\x10\xa2\x38\x2f\x83\x7f\x85\x4d\x1f\x6e\x3c\x4c\x58\x30\xa3\x35\x18\x2f\xfa\x9d\x65\xec\x99\xf2\x14\x8f\x65\x60\xc9\x7c\x30\xca\x0a\xf9\xf3\x40\x38\xb1\x95\x07\xa0\x54\x56\x6c\x99\xa2\x0c\x42\x3b\xda\x66\xb7\xc2\x30\x77\x35\x19\x1e\x96\xee\xbb\x3b\x92\x2e\x5d\x52\x38\x48\xa8\x06\x18\x96\x4c\x74\x57\x76\x4a\x9e\xa3\x74\xf9\xae\x29\xe0\xd8\x6f\x3c\x97\xdd\x38\x23\x1d\x5c\x88\x2f\xad\xaf\xda\x3d\x0a\x76\x59\xfa\x1c\x89\x8e\x29\xcd\x3e\x8d\xf2\x19\x73\x2c\xa3\x48\x12\x5d\xdc\x7e\xbe\x4b\x0f\x08\x24\xbd\x3d\xda\xb1\x29\x2c\xda\xc8\xb2\x99\xc4\xe2\xab\x00\x18\xfa\xb0\xfd\x7c\x59\xea\x8a\x8b\xe5\x26\x5b\x2c\xd1\x3f\x62\x91\xa7\xb5\xf1\x3c\xca\xb6\xb2\x01\xe4\xe9\x96\xb8\xde\xd6\x84\x21\x79\x86\x80\x8b\x87\x96\x94\x1e\x07\xdc\xe8\x21\xf9\x82\xe1\xb3\xba\x2b\x93\x74\x0b\x00\xa3\xbe\x82\xbd\x45\x74\xdb\x4c\xc4\x3a\xc7\x71\x4c\xa7\x3b\xe7\xe7\x0f\x32\x40\xf4\x7b\x91\x6a\xec\x28\xf4\x3e\x14\x32\xea\x1f\x6d\x56\xa9\x83\xfe\x39\x5b\x6b\x2c\x72\xb1\x68\x96\xdc\x68\x8f\x0c\xc7\xe4\x07\x15\xc8\xe4\x73\x3c\x3f\x1e\xf3\x8f\x65\x21\x33\x73\xe4\x86\x13\x1a\xc6\xdc\x5d\xb6\xe3\x92\x48\xf8\xaf\xd6\x4d\x17\x8b\x8f\x49\x97\x17\xf8\x91\x1b\xc7\xcc\x48\x66\xae\xa2\xcc\x98\x22\xfa\xcf\xaf\xdb\x07\x56\x72\xd1\x4a\x74\xe4\x35\x4a\x97\xb7\xa2\xdd\xba\x6c\xa6\x38\x96\x19\x74\xc9\x1d\x33\xd5\xe6\x10\x4e\xcb\xfd\x45\x94\x2b\x45\x49\xb0\xe9\xfe\x3a\x15\x0d\x5a\x87\xee\x67\x51\x34\x7d\x87\x5e\xac\xf1\xf0\xca\x57\x7c\x0f\x0b\x16\x7b\xd5\x4c\x7c\x8a\x77\x27\xf4\x68\x3d\x2e\x67\xe3\x24\x3b\xa6\x98\x57\xba\x45\xc6\xe3\x29\x74\xd0\x5e\x4e\x98\xfd\x1d\x20\xd4\xa0\x4c\xe4\x21\xff\xa3\x00\x50\xe5\xe0\x87\x8a\x17\xe3\x96\x0c\x0c\xcd\xdc\x22\xd4\xec\x4a\x4f\x51\x68\xcc\x03\x4b\x4f\xfb\x12\x4b\x36\x50\x3d\x9d\x6c\x00\xd9\xc9\x37\xd1\x32\xa0\xf3\xd4\x7c\x4f\x12\xdd\x3d\xc0\xab\x17\x42\xc7\x77\x32\x2a\xdc\xc1\x49\xb8\x85\x70\x1f\xf1\x00\xc0\xf7\x0c\xfb\xe1\x32\x6b\xcf\xb0\x04\x6d\x27\x8b\x48\x72\x1d\x93\x7c\x71\xb1\x55\xb2\x6b\x50\xf3\xc0\x15\x17\x3d\x14\xc9\x22\xa5\xf5\xc7\x44\x77\xc2\xc0\x9c\x89\x93\x5c\x20\x4c\xfb\x8a\x5c\xc7\x2e\x5b\x56\xdd\x32\x0c\xec\x67\x38\x07\x9e\xd2\xe3\x34\xd4\xb0\xea\x75\xcb\x9a\x8e\x0b\x7f\xa5\x9d\x1c\x85\x0e\xeb\x93\x50\x9c\xc1\x49\x56\x0d\x43\xa7\xba\xc5\x87\x61\xe0\x4f\xc9\xa1\xe3\x83\xe1\xf3\xba\xae\x1b\x2b\x13\x34\x7a\x0f\x16\xc9\x06\x70\x22\xac\x8f\x20\x54\x3d\xd3\x75\x3a\x05\x83\xea\x7c\x84\x30\x7f\xe0\xa7\x3a\xa7\x86\x97\x50\xfc\x80\x57\x01\xec\xe5\x0d\x3b\x14\xee\x05\xf2\x4f\x92\xc5\x1a\x5c\xb3\xf9\xa9\x1e\xc7\x7c\x4e\x1e\x18\x74\x8a\x11\x4e\x4d\xe9\x82\x15\x38\xc0\x6e\x48\x0c\x33\x1f\xd2\xd3\xe8\x89\x31\xc8\x58\xb9\x97\xc3\x04\x5c\x27\x59\x78\x31\x64\x30\xf6\xe4\x8b\xc9\xb6\xbf\xf8\xf8\x0e\x4c\xdb\x54\x34\x68\x8c\x68\x30\xe4\xc8\xb6\x53\x31\xf9\xb3\x89\x4a\xa1\xd0\x7e\x31\x39\x69\x03\x60\x26\x3b\x4d\xe4\xf8\x6a\xd5\x67\x77\x6e\x71\x4f\x12\x0b\xe7\x8e\x4a\x8c\xe2\x27\x83\xa1\x25\xf1\x90\x4f\x37\x6e\x8e\x04\xec\x96\x39\x7e\xa3\xf2\x24\x1b\xc0\xe3\xe4\x6e\x8d\xbd\x4b\xb7\x5c\x0a\x9e\x5a\xba\x8c\x17\x32\x32\x40\xa0\x61\x7c\x54\xb6\xb0\xae\x8f\x17\xf8\xfb\x52\xdd\xe6\x67\x4a\x37\x10\x38\x3c\xe0\xaf\x64\xc4\x0f\xef\xe9\x71\xd6\xe2\x00\x94\xa6\xec\xc8\xd6\xa0\x4e\x65\x3c\xce\x67\x58\x9e\xb8\x87\x85\x77\x32\x23\xc0\x39\xf2\x5b\xd0\x11\x26\xac\x45\x6b\x10\x67\xcf\x88\xcc\xc9\x9d\x24\x81\xc7\x4d\xab\x5b\xd5\x52\x0c\xf8\x7b\x26\x80\xec\x16\x4c\x02\xd0\x03\x40\x2a\x59\x88\x2b\x21\x02\xea\x46\xf7\xe4\xe3\x4b\xea\xbe\x78\x7b\xaf\xe7\x9d\xca\xe8\x48\xc0\xcf\xe4\x2b\x71\x3f\xd3\x72\xc9\x1d\xb5\x52\xb3\x68\x30\x46\xfc\x12\x69\x0e\x8d\x1c\x09\x65\x32\x10\x6f\x3b\xee\x78\x85\xcc\x00\x5f\xe2\x3b\xec\x61\x99\xc3\x95\xaa\x16\x40\x25\x2c\xc5\xb4\x1a\x3e\x0c\x1e\x43\xc2\xe8\x22\x9c\x58\xaf\xb0\xfb\xd6\xb1\x5b\x63\xd6\x32\x02\xfc\x57\x08\x18\x80\x37\xbe\xa8\x0b\xb7\xe5\xc6\x92\x18\x45\xf0\x8b\x27\x9a\x7b\x77\xc5\xc5\x5f\x64\x6b\xb0\xf6\x4a\xe5\x4e\x43\x87\x07\xfc\x9d\x9c\x64\xf7\x28\x28\xfb\x40\xb8\x69\xe9\x3d\x16\x9a\x01\xa1\xce\x08\xd7\xa3\xcc\x47\x2d\x00\xf4\x6a\x1c\x50\xed\x66\x6b\x2a\x0b\xa2\xd0\xc1\x1b\x06\x95\x1b\xb5\x52\x69\xb3\x9e\xf2\x54\x14\x12\x18\xe3\xe3\x48\xde\xa5\x3e\xba\x55\x29\x97\xee\x57\x3d\x6e\xc1\x11\x90\xac\x6c\x00\x5d\xbc\x9b\x73\x70\xe2\x58\xa9\xd4\xfe\x23\xa9\xc4\xc2\x47\xac\xf1\xe9\xf1\xba\x1e\x86\x96\x68\x09\xe8\x4c\x65\x0a\xa7\x9b\x78\xab\x08\xb7\x76\x22\x9b\x1d\xf7\xef\x61\x8a\xf1\x2e\x97\xc1\xab\x8f\xdc\x92\x2f\x01\x0a\x77\x85\xec\xc1\xb2\x1e\x90\x71\x58\x81\x22\x45\x08\x3f\xe0\x05\xf5\x76\xa9\x7c\x8c\x80\x27\x7b\x01\xde\x6d\xe8\x4e\x36\x91\xe4\x44\xcd\x6b\x02\xe0\xc8\x47\x1d\xd7\xb7\xf4\x6e\xb5\x83\x29\x1e\x23\xe3\xe8\xc2\x29\xa1\xd6\x01\xd0\x75\x8f\xbd\xb9\x8f\x0b\xd8\xff\x34\xa3\x48\x42\xc8\xab\x53\x9e\xef\x96\x02\xf2\x91\xd7\x13\x10\xc0\xac\x6b\x60\x41\x16\x5b\x12\x81\x04\x00\x1b\x2e\x58\xf0\x6d\xc9\xf5\xbd\xcd\x13\x4a\x77\x4c\x54\xc9\x66\xc8\xcb\x20\x08\x4a\x9d\xdf\x20\x2f\xb9\xdf\x0d\xa8\xa3\x0a\xae\x90\x31\xf0\x12\x40\xd4\x93\x1e\x54\xdf\x2c\x7b\x5f\x9d\xf0\x4a\xf0\x3f\x68\x8c\x64\xa4\x83\xb0\xb2\x8f\xd7\x02\xbf\xec\x9e\x3a\x51\xf8\xc4\xeb\x02\x44\xb3\x19\x50\x79\x5c\x63\x02\x24\x25\x5b\x62\x8a\x3f\xf1\x4f\x80\x17\xfb\x4d\x5f\xf1\x6e\x48\x2a\x53\xfc\xef\x89\x53\xcd\x5a\xa7\xec\x9f\xfd\xaa\xf0\xa2\x07\xa0\x0e\xe5\xd1\x3c\x99\xb6\x8c\x84\x7a\x0b\x81\xac\xb4\x3f\x3e\xd1\x2e\x77\x6a\x3e\x18\xf0\x9b\xac\x00\xd1\x4d\xfc\x26\x12\x8e\x8d\x1b\x7a\x52\xa9\xd1\x64\xba\x55\x27\x64\x3e\xe5\x22\x42\x85\xac\xf1\x4f\xdb\x65\xd7\xaf\xd5\x3e\x55\xbc\xe1\x9f\xe2\x1b\xff\x7e\xab\xd5\x7c\xaf\xec\x9f\xb2\x12\x39\xff\x14\x0f\xcc\xba\x75\x8b\x90\x8b\xbd\x00\xd1\x84\xb5\x72\xb9\xd6\xa8\x7d\xa6\xf8\x9e\x2b\xc5\x77\x43\x1c\x27\x13\x2f\x1b\x35\xaf\xd3\xa9\x5a\xba\x9e\xe6\x03\x37\x06\x40\x52\x37\xd2\x51\x10\x33\x44\x2b\xc0\x6c\xff\xa4\xfa\x1d\x09\x95\xdf\x84\x4f\x46\x3e\x3b\x7b\xca\xdf\x4e\x01\xf2\x8a\xc9\xba\x09\x46\xbe\xc5\xc3\x34\x4d\x01\xfa\x8d\xb3\x9f\xfe\x46\x54\xed\xa7\xfe\xfe\xe2\xdb\xcc\x05\x7f\xb0\x8c\x9e\x80\xd7\xc8\x1b\xa6\x33\xe9\x25\x88\x41\x10\xdb\x09\xbf\x1f\xcf\xda\x82\x0c\x11\x18\xad\xb4\x93\x30\x3f\x06\x19\xdc\x00\x9d\xc1\x45\x48\x53\x80\xc6\x15\x70\xb2\x5f\x09\xc9\x01\x90\x8d\x7a\xba\xf0\xc0\x25\x88\x32\xf8\x86\xac\xa4\xbd\x84\x55\x51\xc6\xad\xfe\x2e\xd4\x2f\xe0\xad\x6e\x40\x6a\xa0\x0c\xbe\x41\x21\xec\xa1\x40\xc6\xcd\x7c\x01\x1f\x1c\x04\xc8\x74\x26\xa5\x40\xf0\x4a\xdd\x18\x53\x38\xaf\x35\x30\xe0\x4f\x64\xb5\x1b\x10\xd5\x98\xf4\x06\xc4\x27\x2f\xf7\x79\x97\xb0\xbe\x00\xcf\x93\x9b\x86\x9e\xf6\x12\x70\x05\x06\x48\xac\x74\xa6\xa0\xe3\xfa\xbc\xac\x7c\x97\x8f\x01\x00\x2f\x90\x6b\x5d\x80\x30\xc3\xfa\x15\xf6\xec\x15\x23\xd5\x57\xa0\xf8\xe4\x4a\x9e\x80\xdf\xf6\x04\xd4\x23\x40\x23\xa9\xd2\x14\x95\x66\x25\x4f\x27\xf9\x96\xac\x74\x01\x62\x53\xe1\x0a\xf9\x92\x03\xea\xa9\xd6\x1c\x45\x05\xca\xd5\x8b\xa7\x7b\x02\x3e\x23\xd7\xe1\xdf\xb3\x6e\x40\x9d\x3b\x78\x8e\x80\xf3\x56\x0a\x90\x15\x76\xab\x10\x8a\xaf\xb3\xfe\x75\x42\x04\x19\x20\xc9\x17\xf0\x22\x56\x1e\x49\x35\x06\xc0\x5d\x00\x3c\x0f\x80\x7a\xb4\x08\x45\x23\x2e\x7f\x40\x62\x01\x50\x3a\x21\x60\x52\x32\x43\x76\x8d\xb8\x24\x11\xdd\x19\x16\x8a\xf3\x05\xbc\x92\x04\xe4\xad\xfe\xc7\xe0\x3e\xcc\xc3\x13\x80\xcc\x89\x57\xd5\x13\xad\x41\x00\x7f\xc1\x85\x66\xa4\x9b\xa8\x4c\x4a\x12\x1e\x1e\xb5\xfb\xfb\xd6\xe9\xbe\x2d\xb8\x92\xa8\x7d\x79\xc2\x62\x70\x29\x99\xb6\xa4\xfd\x87\x10\x70\x05\xc8\x73\x05\x9c\x4e\xa4\xd4\x14\xf7\x6c\x42\xad\x63\x80\xfa\x94\x94\x56\xeb\xfd\xcb\x60\xff\x77\x70\x4c\x66\x7d\x2c\x9a\x59\x17\x43\x09\xa2\xa9\x8a\xa5\x7f\x19\xec\x1f\xf0\x56\x0f\xc0\x48\x23\xa7\xd2\x0d\x62\x6b\x23\x77\xc0\x6b\x56\xb2\x28\x81\x25\x78\x25\xd2\xc8\xa9\x84\x09\xa9\xd1\xbf\xca\xf4\x0f\x38\x9d\xac\x8d\x70\xbf\xf0\x4a\xa4\x91\x7c\xbb\x29\x6c\x30\xe8\x18\x63\xbe\xcc\x1b\xf0\x62\x12\x10\x03\xc9\x33\xb1\x8b\x79\x25\x55\x35\xc1\x53\x37\xfb\xbe\xa9\x6d\xdf\x80\xf3\x56\xd7\x3e\xc4\xaa\xe8\x9c\x5e\x49\xf5\x07\x0d\xcb\x7a\xdc\xaf\xca\xf4\x0f\xb8\x92\x00\x64\xbd\x2d\x0e\xf8\x13\x06\xe3\xb4\x71\xa7\xf3\x5e\x83\x2c\xa0\x25\xfa\x57\x3a\x15\x65\xc7\x1c\x06\xe3\x54\x63\x33\x7f\xc0\x2f\xa1\xf0\xa4\x89\xdd\x30\x4a\x8d\x6b\x0c\xf0\x02\xb9\x6c\x24\x8d\x6b\xe9\x42\x21\xf3\x15\x6a\x79\xc3\x9a\x57\x96\x3c\xde\xb2\x60\x9c\x74\x91\x61\x00\x5e\xb4\xa4\x4e\x34\xe5\x62\x12\x26\x04\x89\x30\x08\x2f\xa3\xba\xb5\x92\xbf\x93\x24\x7b\xe5\x6c\xc7\x35\x04\xbc\x28\xed\x34\x52\x76\x3c\x84\x15\x03\x79\x87\x3a\x7d\x2a\x41\x38\x25\x99\x49\xda\xac\xd5\xd9\xc6\x93\xd1\xff\x1c\xf7\x1f\xea\x0c\x3e\x7d\x61\xb8\xa0\xd8\xdb\x0a\xe1\x23\x09\x12\xfb\xdb\x34\xff\x74\x0b\x93\x2a\xd6\xdb\x8d\x4c\x65\x85\x29\xd5\xb7\xa2\x03\x17\x6a\xa0\xc1\x25\x68\x26\x67\xc0\x8d\x3f\x0c\xb1\xc2\xa2\x70\x21\xc1\x8b\x56\xbf\xd8\x8a\x97\xad\x9b\x1b\x20\x79\x60\x51\xe9\xf8\x09\xf0\xad\x46\xef\xd8\xbc\x68\x59\x3c\x61\x10\x5b\xb3\x60\xdd\xfc\xf3\x41\x02\x10\x52\x65\x0e\x3f\x49\x46\xaa\x03\x2f\xe5\x87\x53\xf8\x93\xb7\xf2\x17\xea\x15\x4b\xf2\x61\x40\x48\x38\xaa\xc5\x0e\x57\x88\x8c\x06\x37\x92\x6f\xe6\x0f\x88\x19\x75\xe8\xab\xfc\xb4\x42\x22\xd3\x91\x0a\x26\xdc\xe8\xce\xdf\x82\x58\x19\x19\xe2\x8c\x07\x66\x03\xba\x6c\xc1\x8b\x1c\x90\x6f\x23\xf3\xcd\xf8\x9c\xd7\x20\x24\x04\xe2\x0c\x00\x6a\x32\x5b\x69\xba\xcc\xc0\x1e\x8d\xce\x7e\xa0\xb3\x5f\xce\x57\x07\xe7\xc8\x2a\x15\xa7\x00\xf8\x52\x43\x40\x69\x0d\x3e\x43\x1f\xe1\x1a\x88\x07\x55\x40\x67\x72\x6e\x7d\xfc\x42\xc6\xa2\x03\x5a\x68\x49\x60\xb0\x1e\x24\x16\x80\xa4\x33\xfc\x34\x43\xbe\x80\x98\xaf\xf2\xf3\x08\xec\xa8\x0c\x36\x8e\xac\x6b\xf2\x0b\xea\x9c\x90\x1f\xea\x19\x28\xe1\xea\xbb\xf5\x61\x89\xbe\x9f\xc1\xf6\x9c\x0c\x2b\xd9\x3b\xb8\x66\x44\x47\x17\x18\x63\xfe\x80\xd3\x78\xf9\xe8\xe0\x1b\x48\x49\x3d\xfd\x34\xda\x36\x3a\x43\x33\x2c\x40\xb1\xad\xae\x83\x4c\x77\x01\x32\x37\xd6\xc5\x11\x9a\xdc\x5b\xc0\x62\x8a\xe3\xe3\x14\xa9\x16\xea\x34\x0b\x75\x06\x0b\x36\xc8\x67\xe4\x6c\xc1\x6f\xc9\x63\xf9\x54\x23\x53\x93\xf9\x64\x77\x2e\xf4\x62\xf1\x65\x08\x80\xe1\xc9\x27\x91\xd4\xcb\x4e\x72\x1e\x0a\x3b\xee\x22\x7c\x1b\x07\x9d\x24\xdf\x6d\x88\x0b\x12\x20\xd7\xea\x14\xe0\xae\x58\x7f\xbc\x49\x83\x52\x93\x37\xe0\xe5\x70\x8a\x45\x17\x3a\x01\xf8\x0b\xee\xe5\x49\xe5\xc0\xb0\x00\xa5\x26\x6a\xba\x87\x8a\x9b\x8d\x46\x74\x0c\x6e\xa8\x80\x51\xfb\x60\x3e\x05\x18\xb5\x08\xe9\x10\x2c\xc8\x5b\xf9\xf1\x89\x0a\x6a\x74\x01\xd2\x29\xa9\x93\x9e\xbb\x93\x24\x01\x59\x48\x91\x01\x79\x83\x2b\x7c\xc3\x04\x07\xcc\x5d\xa8\x0d\xe9\x80\x23\xed\x02\xe4\x53\x1c\xbd\x17\x62\x18\xb1\xd8\x88\x27\x10\x23\x45\xb7\x05\x69\x78\x8a\x1a\xf9\x87\x11\x8b\xc3\xad\x10\x3a\xd5\x05\x88\x5b\xb2\x7a\x78\x88\x55\x18\x38\x6f\xc0\x8b\xc9\x0e\x56\x72\x91\xb1\x1d\x4f\x1a\x1d\xb4\xa6\xba\x91\xff\x6e\x67\x0c\xc8\xf6\x0a\x93\x32\x83\x87\x2e\x0c\x01\xc8\xdf\xe0\xa4\xe7\xbe\xdb\x49\x64\x40\x96\x51\x5f\x94\x23\xc9\x65\xcc\x12\xc4\x0c\xb3\x58\x9c\x3f\xe0\x15\xf6\xd6\x25\xf1\x0e\x30\x3c\x7c\x99\x28\x59\xae\xc9\xef\x13\x43\x9d\xce\x79\x3b\x16\xc6\x9b\x99\x99\xff\xc2\xf8\x3b\x7c\xcc\xc0\xb7\x33\x6f\x12\xcf\x4e\xc0\x63\x7f\x87\xe7\xfe\x0f\x5f\x00\xdf\xa7\x9e\xce\xa5\x37\x93\xd3\xf8\x0b\xf0\x2f\xc0\x61\x8f\xff\x01\x92\x6b\x7c\x47\xa0\x73\x59\x6e\x00\x00\x00\x00\x49\x45\x4e\x44\xae\x42\x60\x82');
    }
    return getDisabledPortraitPreviewBitmap.image;
}

function portraitPreviewPlacement(w, h, size, margin) {
    var eyeX = 80, eyeY = 32, crownY = 7, chinY = 52,
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
    var settingsObj = this,
        keys = ['engine', 'useFaceCount', 'portraits', 'portraitSize', 'portraitTop', 'vTop', 'vBottom', 'vSide', 'hTop', 'hBottom', 'hSide'];
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

    this.resolveEngine = function (strict) {
        if (engineIsAvailable(this.engine)) return;
        if (strict) throw new Error(L(str.errActionEngine) + ': ' + this.engine);
        this.engine = bestDefaultEngine();
    };

    // Same playbackParameters scheme as Face alignment.jsx:
    // persistent defaults come from Custom Options, Action playback comes from
    // Photoshop's playbackParameters descriptor.
    this.getScriptSettings = function (fromAction) {
        var d;
        if (fromAction) {
            try { d = app.playbackParameters; } catch (e0) { d = undefined; }
        } else {
            try { d = app.getCustomOptions(UUID); } catch (e1) { d = undefined; }
        }
        if (d != undefined) descriptorToObject(settingsObj, d);

        function descriptorToObject(o, desc) {
            for (var i = 0; i < keys.length; i++) {
                var key = keys[i], k = app.stringIDToTypeID(key);
                if (!desc.hasKey(k)) continue;
                var t = desc.getType(k);
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
        if (toAction) app.playbackParameters = d;
        else app.putCustomOptions(UUID, d, true);

        function objectToDescriptor(o) {
            var desc = new ActionDescriptor();

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
    this.portraitEnable = { ru: 'Согласовать масштаб и линию глаз', en: 'Match face size and eye level' };
    this.portraitSize = { ru: 'Масштаб портрета', en: 'Portrait size' };
    this.portraitSizeHelp = { ru: 'Числовое значение масштаба для точного повторения настройки. Картинка обновляется после отпускания ползунка.', en: 'Numeric portrait size for repeatable settings. The image updates when you release the slider.' };
    this.portraitDirection = { ru: 'Общий план  ← →  Крупный план', en: 'Wider view  ← →  Closer view' };
    this.portraitTop = { ru: 'Мин. отступ над головой, %', en: 'Min. space above head, %' };
    this.portraitTopHelp = { ru: 'Минимальный отступ в процентах высоты рамки. Для общей линии глаз и перекрытия рамки фактическое поле может быть больше.', en: 'Minimum space as a percentage of frame height. The actual gap may be larger to align eyes and cover the frame.' };
    this.portraitPreviewHelp = { ru: 'Пример кадрирования. Зелёная линия — минимальный отступ сверху, синяя — автоматически рассчитанная высота глаз. Реальное размещение учитывает все выбранные портреты.', en: 'Framing example. Green marks the minimum top margin; blue marks automatic eye height. Actual placement accounts for all selected portraits.' };
    this.portraitHelp = { ru: 'Масштаб и высота глаз согласуются автоматически. Отступ над головой — отдельный для портретов. Схема показывает пример, а не результат анализа ваших фотографий.', en: 'Face size and eye height are coordinated automatically. Portraits have their own head margin. The illustration is an example, not an analysis of your photos.' };
    this.portraitSolve = { ru: 'Согласование портретов...', en: 'Matching portrait composition...' };

    this.prepareLayers = { ru: 'Подготовка слоёв...', en: 'Preparing layers...' };
    this.title = { ru: 'Выравнивание и вписывание', en: 'Align and fit layers' };
    this.err = { ru: 'Скрипт остановлен', en: 'Script stopped' };
    this.errActionEngine = { ru: 'Недоступен движок, записанный в операции. Установите его или измените настройки шага операции', en: 'The engine recorded in the action is unavailable. Install it or edit the action step settings' };
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
    this.save = { ru: 'Сохранить настройки', en: 'Save settings' };
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
        if (runCtx.layerMeta[String(id)].smartObject) {
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
        if (!previewInfo.mode || !previewInfo.depth) throw new Error('Cannot read preview color mode or bit depth.');
        if (previewInfo.mode != 'RGBColor' && previewInfo.mode != 'RGBColorMode') doc.convertToRGB();
        if (previewInfo.depth != 8) doc.convertTo8Bit();

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
        return out;
    } catch (e) {
        try {
            if (smartDoc) {
                app.activeDocument = smartDoc;
                doc.close(false);
                smartDoc = null;
            }
        } catch (ignore0) { }
        try { if (file && file.exists) file.remove(); } catch (ignore2) { }
        if (e.number == 8007) throw e;
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
    lr.selectLayers(ids);
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
    this.selectLayers = function (ids) {
        if (!ids || !ids.length) return;
        if (ids.length > 2) {
            // Select the final ID separately to preserve the active layer.
            r = new ActionReference();
            for (var i = 0; i < ids.length - 1; i++) r.putIdentifier(s2t('layer'), ids[i]);
            (d = new ActionDescriptor()).putReference(s2t('null'), r);
            d.putBoolean(s2t('makeVisible'), false);
            executeAction(s2t('select'), d, DialogModes.NO);
            this.selectLayer(ids[ids.length - 1], true);
        } else {
            this.selectLayer(ids[0], false);
            if (ids.length == 2) this.selectLayer(ids[1], true);
        }
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
            if (transformError.number == 8007) throw transformError;
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
            t3 = 0,
            sent = false,
            received = false;
        o.request_id = requestId;

        try {
            if (getData) {
                listener = new Socket();
                if (!listener.listen(portListen, 'UTF-8')) return null;
                t1 = t3 = (new Date()).getTime();
            }

            if (sendData) {
                var sender = new Socket();
                try {
                    if (!sender.open(apiHost + ':' + portSend, 'UTF-8')) return null;
                    sent = sender.writeln(objectToJSON(o));
                    if (!sent) return null;
                } finally {
                    sender.close();
                }
            }

            if (!getData) return true;
            for (;;) {
                t2 = (new Date()).getTime();
                if (t2 - t1 > delay) {
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
                    if (slice > 0 && app.doProgressTask(slice, 'pythonAnalysisProgressChunk();') === false) {
                        throw makeUserCancelError();
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

                    received = true;
                    return a;
                }
                $.sleep(animateProgress ? API_POLL_SLEEP : 1);
            }
        } finally {
            try { if (listener) listener.close(); } catch (closeError) { }
            if (sent && getData && o.type == 'analyze' && !received) cancelAnalysis(requestId);
        }
    }

    function cancelAnalysis(requestId) {
        var sender = new Socket();
        try {
            sender.timeout = 1;
            if (sender.open(apiHost + ':' + portSend, 'UTF-8')) {
                sender.writeln(objectToJSON({type: 'cancel', message: {request_id: requestId}}));
            }
        } catch (cancelError) { } finally {
            try { sender.close(); } catch (closeError) { }
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
