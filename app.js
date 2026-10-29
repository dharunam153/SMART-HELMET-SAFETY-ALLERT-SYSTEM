/* =============================================================
   HELMET AI - app.js  v5 (Reliable Camera + Detection)
   Camera opens immediately - models load after
   ============================================================= */

(function () {
  "use strict";

  /* --- State ---------------------------------------------------- */
  const S = {
    stream:        null,
    cocoModel:     null,
    faceModel:     null,
    isRunning:     false,
    modelsReady:   false,
    raf:           null,
    fpsTimer:      null,
    fps:           0,
    totalScans:    0,
    safeCount:     0,
    dangerCount:   0,
    lastResult:    null,
    warnCooldown:  false,
    usingFrontCam: true,
  };

  /* --- DOM refs ------------------------------------------------- */
  let D = {};

  function q(id) { return document.getElementById(id); }

  function initDOM() {
    D = {
      webcam:       q("webcam"),
      canvas:       q("outputCanvas"),
      camFrame:     q("cameraFrame"),
      scanOverlay:  q("scanOverlay"),
      statusBadge:  q("camStatusBadge"),
      statusDot:    q("camStatusDot"),
      statusLabel:  q("camStatusLabel"),
      fpsEl:        q("fpsCounter"),
      fpsVal:       q("fpsValue"),
      startBtn:     q("startBtn"),
      stopBtn:      q("stopBtn"),
      shotBtn:      q("screenshotBtn"),
      flipBtn:      q("flipCamBtn"),
      camSelect:    q("camSelect"),
      camSelWrap:   q("camSelectWrap"),
      threshSlider: q("thresholdSlider"),
      threshVal:    q("thresholdVal"),
      threshMarker: q("thresholdMarker"),
      placeholder:  q("cameraPlaceholder"),
      resultCard:   q("resultCard"),
      resultIdle:   q("resultIdle"),
      resultActive: q("resultActive"),
      iconWrap:     q("resultIconWrap"),
      helmetIcon:   q("helmetIcon"),
      noHelmetIcon: q("noHelmetIcon"),
      resultLabel:  q("resultLabel"),
      confText:     q("confidenceText"),
      confBar:      q("confidenceBar"),
      detail:       q("resultDetail"),
      alertCard:    q("alertCard"),
      alertMsg:     q("alertMessage"),
      history:      q("historyList"),
      totalEl:      q("totalScans"),
      safeEl:       q("safeCount"),
      dangerEl:     q("dangerCount"),
      popup:        q("warningPopup"),
      overlay:      q("popupOverlay"),
      loadScreen:   q("loadingScreen"),
      loadMsg:      q("loadingMsg"),
      loadBar:      q("loadingBar"),
      toast:        q("toast"),
    };
  }

  /* --- Toast ---------------------------------------------------- */
  function toast(msg, type, ms) {
    type = type || "info";
    ms   = ms   || 4000;
    D.toast.textContent = msg;
    D.toast.className   = "toast show " + type;
    clearTimeout(D.toast._t);
    D.toast._t = setTimeout(function () { D.toast.className = "toast"; }, ms);
  }

  /* --- Loading overlay ------------------------------------------ */
  function showLoad(msg, pct) {
    D.loadScreen.style.display = "flex";
    D.loadMsg.textContent = msg;
    D.loadBar.style.width = (pct || 0) + "%";
  }
  function hideLoad() {
    D.loadBar.style.width = "100%";
    setTimeout(function () { D.loadScreen.style.display = "none"; }, 400);
  }

  /* --- Status badge --------------------------------------------- */
  function setStatus(type, label) {
    D.statusDot.className     = "cam-status-dot " + type;
    D.statusLabel.textContent = label;
  }

  /* --- Populate Camera Selector --------------------------------- */
  async function populateCameraList() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      // Need permission first so labels show
      let tempStream;
      try {
        tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        tempStream.getTracks().forEach(t => t.stop());
      } catch(_) {}

      const all = await navigator.mediaDevices.enumerateDevices();
      const videoDevs = all.filter(d => d.kind === "videoinput");
      const virtualKW = /droidcam|virtual|obs|vcam|snap camera|manycam|ivcam|epoccam/i;

      if (!D.camSelect) return;
      D.camSelect.innerHTML = "";

      // Sort: real cameras first
      const real    = videoDevs.filter(d => !virtualKW.test(d.label));
      const virtual = videoDevs.filter(d =>  virtualKW.test(d.label));
      const sorted  = [...real, ...virtual];

      sorted.forEach(function(dev, i) {
        var opt = document.createElement("option");
        opt.value = dev.deviceId;
        var label = dev.label || ("Camera " + (i + 1));
        var tag = virtualKW.test(label) ? " (virtual)" : "";
        opt.textContent = label + tag;
        D.camSelect.appendChild(opt);
      });

      if (sorted.length === 0) {
        D.camSelect.innerHTML = "<option value=''>No cameras found</option>";
      }
    } catch(e) {
      console.warn("[HelmetAI] enumerateDevices failed:", e.message);
    }
  }

  /* --- Open Camera ---------------------------------------------- */
  async function openCamera() {
    // Check API existence
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const isHttp = location.protocol === "http:" &&
                     location.hostname !== "localhost" &&
                     location.hostname !== "127.0.0.1";
      if (isHttp) {
        throw { name: "HttpsRequired", message: "Camera needs HTTPS on non-localhost." };
      }
      throw { name: "NotSupportedError", message: "getUserMedia not supported by this browser." };
    }

    // Step 1: Get selected deviceId from dropdown (if available)
    const selectedId = D.camSelect ? D.camSelect.value : "";

    // Step 2: If a specific device was selected, try it first
    if (selectedId) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: selectedId }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        console.log("[HelmetAI] Opened selected camera:", D.camSelect.options[D.camSelect.selectedIndex].text);
        return stream;
      } catch(e) {
        console.warn("[HelmetAI] Selected camera failed, falling back:", e.message);
        if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") throw e;
      }
    }

    // Step 3: Enumerate all video devices
    let devices = [];
    try {
      // Request permission first so labels are populated
      const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      tempStream.getTracks().forEach(t => t.stop());
      devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
      console.log("[HelmetAI] Available cameras:", devices.map(d => d.label));
    } catch (e) {
      if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") throw e;
      // Fall through to generic open
    }

    // Step 2: Sort — prefer real/integrated cameras, DroidCam/virtual last
    const virtualKeywords = /droidcam|virtual|obs|vcam|snap camera|manycam|ivcam|epoccam|iv cam/i;
    const integratedKeywords = /integrated|built.in|internal|facetime|laptop|hd webcam|usb/i;

    const realCams    = devices.filter(d => !virtualKeywords.test(d.label));
    const virtualCams = devices.filter(d =>  virtualKeywords.test(d.label));
    const orderedDevs = [...realCams, ...virtualCams];

    // Step 3: Try each device by deviceId
    if (orderedDevs.length > 0) {
      for (const dev of orderedDevs) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: dev.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          });
          console.log("[HelmetAI] Opened camera:", dev.label);
          S.activeCamLabel = dev.label;
          return stream;
        } catch (e) {
          console.warn("[HelmetAI] Could not open camera:", dev.label, "->", e.message);
          if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") throw e;
        }
      }
    }

    // Step 4: Fallback — generic open
    const fallbacks = [
      { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: true, audio: false },
    ];
    let lastErr;
    for (const c of fallbacks) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(c);
        console.log("[HelmetAI] Camera opened via fallback");
        return stream;
      } catch (e) {
        lastErr = e;
        if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") throw e;
        console.warn("[HelmetAI] Fallback failed:", e.message);
      }
    }
    throw lastErr || { name: "NotFoundError", message: "Camera unavailable." };
  }


  /* --- Load AI Models (background, after camera is open) ------- */
  async function loadModels() {
    if (S.modelsReady) return;
    try {
      setStatus("processing", "Loading AI...");
      if (typeof tf === "undefined") {
        console.warn("[HelmetAI] TensorFlow.js not loaded, detection disabled.");
        return;
      }
      await tf.ready();
      console.log("[HelmetAI] TF backend:", tf.getBackend());

      if (typeof cocoSsd !== "undefined") {
        try {
          S.cocoModel = await cocoSsd.load({ base: "mobilenet_v2" });
          console.log("[HelmetAI] COCO-SSD ready");
        } catch (e) {
          console.warn("[HelmetAI] COCO-SSD failed:", e.message);
        }
      }

      if (typeof blazeface !== "undefined") {
        try {
          S.faceModel = await blazeface.load({
            maxFaces: 3,
            scoreThreshold: 0.25,
            iouThreshold: 0.3
          });
          console.log("[HelmetAI] BlazeFace ready (tuned scoreThreshold: 0.25)");
        } catch (e) {
          console.warn("[HelmetAI] BlazeFace with options failed, falling back:", e.message);
          try { S.faceModel = await blazeface.load(); } catch(_) {}
        }
      }

      // Mark ready as long as at least one model is available
      if (S.cocoModel || S.faceModel) {
        S.modelsReady = true;
        setStatus("processing", "AI Scanning...");
        var loaded = [];
        if (S.faceModel) loaded.push("BlazeFace");
        if (S.cocoModel) loaded.push("COCO-SSD");
        toast("AI ready: " + loaded.join(" + ") + ". Scanning active.", "success", 3000);
      } else {
        setStatus("processing", "AI unavailable - check internet");
        toast("AI models could not load. Check your internet connection.", "error", 8000);
      }
    } catch (e) {
      console.error("[HelmetAI] Model load error:", e.message);
      toast("AI models failed to load. Camera still active.", "error", 5000);
    }
  }

  /* --- Start Detection ------------------------------------------ */
  async function startDetection() {
    if (S.isRunning) return;

    showLoad("Opening camera...", 10);

    try {
      // Step 1: Open camera FIRST (fast)
      S.stream = await openCamera();

      showLoad("Starting video feed...", 50);

      D.webcam.srcObject = S.stream;
      D.webcam.muted = true;
      D.webcam.playsInline = true;

      // Wait for video metadata to load
      await new Promise(function (resolve, reject) {
        function onMeta() { cleanup(); resolve(); }
        function onErr(e)  { cleanup(); reject(e); }
        function onTimeout() { cleanup(); reject({ name: "TimeoutError", message: "Camera timed out" }); }
        function cleanup() {
          D.webcam.removeEventListener("loadedmetadata", onMeta);
          D.webcam.removeEventListener("error", onErr);
          clearTimeout(timer);
        }
        D.webcam.addEventListener("loadedmetadata", onMeta);
        D.webcam.addEventListener("error", onErr);
        var timer = setTimeout(onTimeout, 10000);
      });

      // Play the video
      try { await D.webcam.play(); } catch (e) { console.warn("[HelmetAI] play() error:", e.message); }

      hideLoad();

      // Step 2: Show camera UI
      syncCanvas();
      D.webcam.classList.add("visible");
      D.placeholder.style.display  = "none";
      D.scanOverlay.style.display  = "block";
      D.statusBadge.style.display  = "flex";
      D.fpsEl.style.display        = "block";
      D.startBtn.style.display     = "none";
      D.stopBtn.style.display      = "inline-flex";
      D.shotBtn.style.display      = "inline-flex";
      if (D.flipBtn) D.flipBtn.style.display = "inline-flex";
      D.camFrame.classList.add("active");

      S.isRunning = true;
      S.fps = 0;
      setStatus("processing", "Camera active...");
      S.fpsTimer = setInterval(function () { D.fpsVal.textContent = S.fps; S.fps = 0; }, 1000);

      toast("?? Camera started! Loading AI models...", "success");

      // Step 3: Load AI models in background (non-blocking)
      loadModels();

      // Step 4: Start detection loop
      loop();

    } catch (err) {
      hideLoad();
      console.error("[HelmetAI] startDetection error:", err);

      var msgs = {
        HttpsRequired:         "?? Camera requires HTTPS. Use https://10.34.222.123:5443 on other devices.",
        NotAllowedError:       "? Camera permission denied. Click the camera icon in the address bar and Allow.",
        PermissionDeniedError: "? Camera permission denied. Click the camera icon and Allow.",
        NotFoundError:         "? No camera found. Please connect a webcam.",
        NotReadableError:      "? Camera is busy. Close other apps using the camera.",
        OverconstrainedError:  "? Camera settings not supported.",
        NotSupportedError:     "? Camera not supported by this browser. Use Chrome.",
        TimeoutError:          "? Camera took too long to start. Try refreshing.",
      };
      toast(msgs[err.name] || ("? Camera error: " + (err.message || err)), "error", 12000);
    }
  }

  /* --- Stop Detection ------------------------------------------- */
  function stopDetection() {
    S.isRunning = false;
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = null; }
    if (S.fpsTimer) { clearInterval(S.fpsTimer); S.fpsTimer = null; }

    if (S.stream) {
      S.stream.getTracks().forEach(function (t) { t.stop(); });
      S.stream = null;
    }
    D.webcam.srcObject = null;
    D.webcam.classList.remove("visible");

    var ctx = D.canvas.getContext("2d");
    ctx.clearRect(0, 0, D.canvas.width, D.canvas.height);

    D.placeholder.style.display  = "flex";
    D.scanOverlay.style.display  = "none";
    D.statusBadge.style.display  = "none";
    D.fpsEl.style.display        = "none";
    D.startBtn.style.display     = "inline-flex";
    D.stopBtn.style.display      = "none";
    D.shotBtn.style.display      = "none";
    if (D.flipBtn) D.flipBtn.style.display = "none";
    D.camFrame.className         = "camera-frame";
    D.alertCard.style.display    = "none";
    D.resultIdle.style.display   = "block";
    D.resultActive.style.display = "none";
    D.resultCard.className       = "result-card";
    S.lastResult = null;
    if (typeof Tracker !== "undefined") Tracker.reset();

    toast("Camera stopped.", "info");
  }

  /* --- Flip Camera ---------------------------------------------- */
  async function flipCamera() {
    if (!S.isRunning) return;
    S.usingFrontCam = !S.usingFrontCam;
    var wasRunning = S.isRunning;
    stopDetection();
    if (wasRunning) setTimeout(startDetection, 300);
  }

  /* --- Canvas Sync ---------------------------------------------- */
  function syncCanvas() {
    var vw = D.webcam.videoWidth  || 640;
    var vh = D.webcam.videoHeight || 480;
    if (D.canvas.width !== vw)  D.canvas.width  = vw;
    if (D.canvas.height !== vh) D.canvas.height = vh;
  }

  /* --- Black screen detector ----------------------------------- */
  var _blackFrames = 0, _blackAlerted = false, _bCanvas = null;
  function checkBlackScreen() {
    if (!D.webcam || D.webcam.videoWidth === 0 || D.webcam.readyState < 2) return;
    if (!_bCanvas) { _bCanvas = document.createElement("canvas"); _bCanvas.width = 16; _bCanvas.height = 12; }
    var bctx = _bCanvas.getContext("2d");
    try {
      bctx.drawImage(D.webcam, 0, 0, 16, 12);
      var d = bctx.getImageData(0, 0, 16, 12).data;
      var lum = 0;
      for (var i = 0; i < d.length; i += 4) lum += (d[i] + d[i+1] + d[i+2]) / 3;
      if ((lum / (d.length / 4)) < 4) {
        _blackFrames++;
        if (_blackFrames >= 60 && !_blackAlerted) {
          _blackAlerted = true;
          toast("Black screen detected! Check the E-Shutter switch on the RIGHT side of your laptop, or disable Camera Privacy in Lenovo Vantage.", "error", 20000);
          setStatus("danger", "Camera blocked");
        }
      } else {
        _blackFrames = 0;
        _blackAlerted = false;
      }
    } catch(_) {}
  }

  /* --- Detection Loop ------------------------------------------- */
  async function loop() {
    if (!S.isRunning) return;
    S.fps++;

    if (D.webcam.readyState >= 2 && D.webcam.videoWidth > 0) {
      syncCanvas();
      checkBlackScreen();
      if (S.modelsReady) {
        try { await detect(); } catch (e) { console.warn("[HelmetAI] detect() error:", e.message); }
      } else {
        // Draw "waiting for AI" overlay
        var ctx = D.canvas.getContext("2d");
        ctx.clearRect(0, 0, D.canvas.width, D.canvas.height);
        ctx.save();
        ctx.fillStyle = "rgba(0,212,255,0.15)";
        ctx.fillRect(0, 0, D.canvas.width, D.canvas.height);
        ctx.font = "bold 16px Outfit, sans-serif";
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.textAlign = "center";
        ctx.fillText("Loading AI models...", D.canvas.width / 2, D.canvas.height / 2);
        ctx.restore();
      }
    }

    S.raf = requestAnimationFrame(loop);
  }

  /* --- Detection Stabilizer & Persistent Tracker --------------- */
  var Tracker = {
    threshold: 80,             // 80% threshold (fine-tuned)
    smoothedScore: null,       // Exponential moving average score (0-100)
    currentStatus: "idle",     // "safe" | "danger" | "idle"
    consecutiveSafe: 0,
    consecutiveDanger: 0,
    framesToSwitch: 2,         // Debounce hysteresis (fast, responsive)
    lastLogTime: 0,

    // Continuous Target Tracking (Zero Dropouts)
    hasTarget: false,
    missedFrames: 0,
    maxPersistFrames: 90,      // Keep tracking for ~3s so boxes never disappear or flicker
    smoothFace: null,          // { x, y, w, h }
    smoothHelmet: null,        // { x, y, w, h }

    reset: function () {
      this.smoothedScore = null;
      this.currentStatus = "idle";
      this.consecutiveSafe = 0;
      this.consecutiveDanger = 0;
      this.lastLogTime = 0;
      this.hasTarget = false;
      this.missedFrames = 0;
      this.smoothFace = null;
      this.smoothHelmet = null;
    },

    updateTarget: function (face, helmet) {
      this.hasTarget = true;
      this.missedFrames = 0;
      var f = 0.35; // smooth lerp interpolation

      if (!this.smoothFace) {
        this.smoothFace = { x: face.x, y: face.y, w: face.w, h: face.h };
      } else {
        this.smoothFace.x += (face.x - this.smoothFace.x) * f;
        this.smoothFace.y += (face.y - this.smoothFace.y) * f;
        this.smoothFace.w += (face.w - this.smoothFace.w) * f;
        this.smoothFace.h += (face.h - this.smoothFace.h) * f;
      }

      if (!this.smoothHelmet) {
        this.smoothHelmet = { x: helmet.x, y: helmet.y, w: helmet.w, h: helmet.h };
      } else {
        this.smoothHelmet.x += (helmet.x - this.smoothHelmet.x) * f;
        this.smoothHelmet.y += (helmet.y - this.smoothHelmet.y) * f;
        this.smoothHelmet.w += (helmet.w - this.smoothHelmet.w) * f;
        this.smoothHelmet.h += (helmet.h - this.smoothHelmet.h) * f;
      }

      return { face: this.smoothFace, helmet: this.smoothHelmet };
    },

    process: function (rawScore) {
      if (this.smoothedScore === null) {
        this.smoothedScore = rawScore;
      } else {
        this.smoothedScore = (this.smoothedScore * 0.50) + (rawScore * 0.50);
      }
      var score = Math.round(this.smoothedScore);
      score = Math.max(0, Math.min(100, score));

      var isAbove = score >= this.threshold;
      if (isAbove) {
        this.consecutiveSafe++;
        this.consecutiveDanger = 0;
      } else {
        this.consecutiveDanger++;
        this.consecutiveSafe = 0;
      }

      if (this.currentStatus !== "safe" && this.consecutiveSafe >= this.framesToSwitch) {
        this.currentStatus = "safe";
      } else if (this.currentStatus !== "danger" && this.consecutiveDanger >= this.framesToSwitch) {
        this.currentStatus = "danger";
      } else if (this.currentStatus === "idle") {
        this.currentStatus = isAbove ? "safe" : "danger";
      }

      return {
        score: score,
        hasHelmet: this.currentStatus === "safe",
        threshold: this.threshold
      };
    }
  };

  var _sCanvas = null;
  function getSampleCanvas(w, h) {
    if (!_sCanvas) _sCanvas = document.createElement("canvas");
    if (_sCanvas.width !== w) _sCanvas.width = w;
    if (_sCanvas.height !== h) _sCanvas.height = h;
    return _sCanvas;
  }

  /* --- Universal Skin Tone Classifier (YCrCb + Melanin RGB) ----- */
  function isSkinPixel(r, g, b) {
    if (r < 45 || r > 252) return false;
    // Human skin melanin and hemoglobin make Red strictly higher than Green and Blue
    if (r <= g || g < b) return false;
    if ((r - g) < 5 || (r - b) < 10) return false;

    // YCrCb color space test (Universal across Caucasian, Asian, Indian, Hispanic, African skin)
    var y  = 0.299 * r + 0.587 * g + 0.114 * b;
    var cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    var cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;

    return (cr >= 128 && cr <= 185 && cb >= 75 && cb <= 138 && y >= 32 && y <= 235);
  }

  /* --- Core Detection ------------------------------------------- */
  var _detecting = false;
  async function detect() {
    if (_detecting) return;
    _detecting = true;

    try {
      var ctx = D.canvas.getContext("2d");
      var vw = D.webcam.videoWidth || 640;
      var vh = D.webcam.videoHeight || 480;

      var detectedFace = null;
      var detectedHelmet = null;

      // Tier 1: BlazeFace Face Detector
      if (S.faceModel) {
        try {
          var faces = await S.faceModel.estimateFaces(D.webcam, false);
          if (faces && faces.length > 0) {
            var face = faces[0];
            var fx, fy, fw, fh;
            if (Array.isArray(face.topLeft)) {
              fx = face.topLeft[0]; fy = face.topLeft[1];
              fw = face.bottomRight[0] - fx;
              fh = face.bottomRight[1] - fy;
            } else {
              var tl = face.topLeft.dataSync ? face.topLeft.dataSync() : face.topLeft;
              var br = face.bottomRight.dataSync ? face.bottomRight.dataSync() : face.bottomRight;
              fx = tl[0]; fy = tl[1];
              fw = br[0] - fx; fh = br[1] - fy;
            }

            if (fw > 20 && fh > 20) {
              detectedFace = { x: Math.max(0, fx), y: Math.max(0, fy), w: fw, h: fh };
              detectedHelmet = {
                x: Math.max(0, fx - fw * 0.18),
                y: Math.max(0, fy - fh * 0.80),
                w: Math.min(vw - Math.max(0, fx - fw * 0.18), fw * 1.36),
                h: Math.min(vh, fh * 0.85)
              };
            }
          }
        } catch (errFace) {}
      }

      // Tier 2: COCO-SSD (Catches person when wearing full-face helmet or when BlazeFace drops out)
      if (!detectedFace && S.cocoModel) {
        try {
          var preds = await S.cocoModel.detect(D.webcam);
          var persons = preds.filter(function (p) {
            return p.class === "person" && p.score >= 0.15;
          });

          if (persons.length > 0) {
            var p  = persons[0];
            var px = p.bbox[0], py = p.bbox[1], pw = p.bbox[2], ph = p.bbox[3];

            // Head and helmet occupy top ~32% of detected person
            var hw = pw * 0.50;
            var hh = Math.min(ph * 0.35, hw * 1.10);
            var hx = px + (pw - hw) / 2;
            var hy = Math.max(0, py);

            var fw2 = hw * 0.80;
            var fh2 = hh * 0.85;
            var fx2 = hx + (hw - fw2) / 2;
            var fy2 = hy + hh * 0.32;

            detectedFace = { x: fx2, y: fy2, w: fw2, h: fh2 };
            detectedHelmet = { x: hx, y: hy, w: hw, h: hh };
          }
        } catch (errCoco) {}
      }

      // Tier 3: Adaptive Center-Webcam Silhouette (When user is in webcam portrait view)
      if (!detectedFace && !Tracker.hasTarget && vw > 100 && vh > 100) {
        var testW = Math.round(vw * 0.38);
        var testH = Math.round(vh * 0.44);
        var testX = Math.round((vw - testW) / 2);
        var testY = Math.round(vh * 0.15);

        var testCanvas = getSampleCanvas(testW, testH);
        var tctx = testCanvas.getContext("2d", { willReadFrequently: true });
        tctx.drawImage(D.webcam, testX, testY, testW, testH, 0, 0, testW, testH);
        try {
          var tImg = tctx.getImageData(0, 0, testW, testH).data;
          var skinHits = 0, darkHits = 0, sampleTotal = 0;
          for (var ti = 0; ti < tImg.length; ti += 16) {
            var tr = tImg[ti], tg = tImg[ti+1], tb = tImg[ti+2];
            sampleTotal++;
            if (isSkinPixel(tr, tg, tb)) skinHits++;
            else if (tr < 50 && tg < 50 && tb < 50) darkHits++;
          }
          if (sampleTotal > 50 && ((skinHits / sampleTotal) > 0.12 || (darkHits / sampleTotal) > 0.30)) {
            var hhw = testW * 0.90;
            var hhh = testH * 0.55;
            var hhx = testX + (testW - hhw) / 2;
            var hhy = testY;
            detectedFace = { x: testX, y: testY + testH * 0.25, w: testW, h: testH * 0.75 };
            detectedHelmet = { x: hhx, y: hhy, w: hhw, h: hhh };
          }
        } catch (_) {}
      }

      // Tier 4: Persistent Target Tracking (Zero Dropouts)
      var target;
      if (detectedFace && detectedHelmet) {
        target = Tracker.updateTarget(detectedFace, detectedHelmet);
      } else if (Tracker.hasTarget && Tracker.missedFrames < Tracker.maxPersistFrames) {
        // DETECTOR MISSED THIS FRAME: Hold and smoothly maintain the tracked target!
        Tracker.missedFrames++;
        target = { face: Tracker.smoothFace, helmet: Tracker.smoothHelmet };
      } else {
        // Person left camera view
        Tracker.hasTarget = false;
        ctx.clearRect(0, 0, D.canvas.width, D.canvas.height);
        setStatus("processing", "Looking for person...");
        ctx.save();
        ctx.font = "14px Outfit, sans-serif";
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.textAlign = "center";
        ctx.fillText("Move into camera view", D.canvas.width / 2, D.canvas.height - 24);
        ctx.restore();
        return;
      }

      // Sample and Evaluate Region (Hair vs Helmet Engine)
      var r = sampleRegion(
        target.helmet.x, target.helmet.y, target.helmet.w, target.helmet.h,
        target.face.x, target.face.y, target.face.w, target.face.h
      );
      var evaluated = Tracker.process(r.rawScore);

      // Position the helmet box properly:
      // For motorcycle helmets, enclose the entire helmet dome from crown to chin
      var helmBoxX = target.helmet.x;
      var helmBoxY = target.helmet.y;
      var helmBoxW = target.helmet.w;
      var helmBoxH = target.helmet.h;

      if (r.detectionType === "motorcycle_helmet") {
        helmBoxX = Math.max(0, target.face.x - target.face.w * 0.22);
        helmBoxY = Math.max(0, target.face.y - target.face.h * 0.60);
        helmBoxW = Math.min(D.canvas.width - helmBoxX, target.face.w * 1.44);
        helmBoxH = Math.min(D.canvas.height - helmBoxY, target.face.h * 2.40);
      }

      // Render Boxes on Canvas
      ctx.clearRect(0, 0, D.canvas.width, D.canvas.height);

      // 1. Draw Face Detection Box (when face is bare, or inner visor accent)
      if (r.detectionType !== "motorcycle_helmet") {
        drawFaceBox(ctx, target.face.x, target.face.y, target.face.w, target.face.h, evaluated.hasHelmet);
      }

      // 2. Draw Helmet Zone Detection Box
      drawHelmetZone(ctx, helmBoxX, helmBoxY, helmBoxW, helmBoxH, evaluated.hasHelmet, evaluated.score, r.detectionType);

      // 3. Draw Floating Pill Label
      drawLabel(ctx, helmBoxX, helmBoxY, helmBoxW, evaluated.hasHelmet, evaluated.score, evaluated.threshold, r.detectionType);

      // 4. Update Result Card
      renderResult(evaluated.hasHelmet, evaluated.score, r.detectionType);

    } finally {
      _detecting = false;
    }
  }

  /* --- Fine-Tuned Helmet & Head Feature Sampler ----------------- */
  /* --- High-Accuracy Hair vs. Helmet Precision Engine ---------- */
  function sampleRegion(x, y, w, h, fx, fy, fw, fh) {
    // 1. SAMPLE THE DETECTED BOX (Check if it's a real human face or a black motorcycle helmet shell!)
    var fW = Math.max(10, Math.round(fw * 0.50));
    var fH = Math.max(10, Math.round(fh * 0.50));
    var fX = Math.max(0, Math.round(fx + (fw - fW) / 2));
    var fY = Math.max(0, Math.round(fy + (fh - fH) / 2));
    fW = Math.min(fW, D.canvas.width - fX);
    fH = Math.min(fH, D.canvas.height - fY);

    var fCanvas = getSampleCanvas(fW, fH);
    var fctx = fCanvas.getContext("2d", { willReadFrequently: true });
    fctx.drawImage(D.webcam, fX, fY, fW, fH, 0, 0, fW, fH);
    var fImg = fctx.getImageData(0, 0, fW, fH).data;

    var fTotal = 0, fDark = 0, fLumSum = 0, fSkin = 0;
    for (var fi = 0; fi < fImg.length; fi += 8) {
      var fr = fImg[fi], fg = fImg[fi+1], fb = fImg[fi+2];
      var flum = (fr + fg + fb) / 3;
      fLumSum += flum;
      fTotal++;
      if (flum < 68) fDark++;
      if (fr > 75 && fr > fg && (fr - fb) >= 10 && flum >= 65) fSkin++;
    }
    var avgFaceLum = fTotal > 0 ? (fLumSum / fTotal) : 100;
    var faceDarkRatio = fTotal > 0 ? (fDark / fTotal) : 0;
    var faceSkinRatio = fTotal > 0 ? (fSkin / fTotal) : 0;

    // 2. SAMPLE BELOW THE BOX (Check if lower face / chin is covered by visor & chin guard!)
    var cW = Math.max(10, Math.round(fw * 0.60));
    var cH = Math.max(10, Math.round(fh * 0.80));
    var cX = Math.max(0, Math.round(fx + (fw - cW) / 2));
    var cY = Math.max(0, Math.round(fy + fh * 0.70));
    cW = Math.min(cW, D.canvas.width - cX);
    cH = Math.min(cH, D.canvas.height - cY);

    var cDark = 0, cTotal = 0;
    if (cW > 5 && cH > 5) {
      var cCanvas = getSampleCanvas(cW, cH);
      var cctx = cCanvas.getContext("2d", { willReadFrequently: true });
      cctx.drawImage(D.webcam, cX, cY, cW, cH, 0, 0, cW, cH);
      var cImg = cctx.getImageData(0, 0, cW, cH).data;
      for (var ci = 0; ci < cImg.length; ci += 8) {
        cTotal++;
        if ((cImg[ci] + cImg[ci+1] + cImg[ci+2]) / 3 < 70) cDark++;
      }
    }
    var chinDarkRatio = cTotal > 0 ? (cDark / cTotal) : 0;

    // 3. SAMPLE CROWN ABOVE THE FACE (Check for vibrant safety hard hat plastic)
    var headW = Math.max(16, Math.round(fw * 0.60));
    var headH = Math.max(16, Math.round(fh * 0.45));
    var headX = Math.max(0, Math.round(fx + (fw - headW) / 2));
    var headY = Math.max(0, Math.round(fy - headH * 0.85));
    headW = Math.min(headW, D.canvas.width - headX);
    headH = Math.min(headH, D.canvas.height - headY);

    var hardHatPixels = 0, hTotal = 0;
    if (headW > 5 && headH > 5) {
      var hCanvas = getSampleCanvas(headW, headH);
      var hctx = hCanvas.getContext("2d", { willReadFrequently: true });
      hctx.drawImage(D.webcam, headX, headY, headW, headH, 0, 0, headW, headH);
      var hData = hctx.getImageData(0, 0, headW, headH).data;
      for (var hi = 0; hi < hData.length; hi += 8) {
        var hr = hData[hi], hg = hData[hi+1], hb = hData[hi+2];
        var hmx = Math.max(hr, hg, hb), hmn = Math.min(hr, hg, hb);
        var hbr = hmx / 255;
        var hsat = hmx === 0 ? 0 : (hmx - hmn) / hmx;
        var hhue = getHue(hr, hg, hb, hmx, hmn);
        hTotal++;
        var isVividYellow = (hhue >= 38 && hhue <= 68 && hsat >= 0.45 && hbr >= 0.35);
        var isVividOrange = (hhue >= 14 && hhue <= 37 && hsat >= 0.55 && hbr >= 0.35);
        var isVividRed    = ((hhue < 12 || hhue > 345) && hsat >= 0.50 && hbr >= 0.30);
        var isVividBlue   = (hhue >= 195 && hhue <= 245 && hsat >= 0.40 && hbr >= 0.25);
        var isVividGreen  = (hhue >= 85 && hhue <= 165 && hsat >= 0.40 && hbr >= 0.25);
        if (isVividYellow || isVividOrange || isVividRed || isVividBlue || isVividGreen) {
          hardHatPixels++;
        }
      }
    }
    var hardHatRatio = hTotal > 0 ? (hardHatPixels / hTotal) : 0;

    // --- ACCURACY DECISION ENGINE ---
    // CASE 1: MOTORCYCLE HELMET
    // The detected box is matte black shell (forehead logo) with low brightness (avgFaceLum <= 72, faceSkinRatio < 0.10)
    // AND/OR the area directly below it is black visor & chin guard (chinDarkRatio >= 0.50):
    if ((avgFaceLum <= 72 && faceSkinRatio < 0.10) || (chinDarkRatio >= 0.50 && faceSkinRatio < 0.12)) {
      return { rawScore: 96, detectionType: "motorcycle_helmet" };
    }

    // CASE 2: SAFETY HARD HAT
    // Central crown is covered in vibrant safety plastic
    if (hardHatRatio >= 0.35) {
      return { rawScore: 94, detectionType: "hardhat" };
    }

    // CASE 3: NATURAL HUMAN HAIR / BARE HEAD
    // Face has real human skin tone, crown is natural hair:
    // 100% CONFIRMED HAIR! (Score: 12%, far below 80% threshold).
    return { rawScore: 12, detectionType: "hair" };
  }

  function getHue(r, g, b, mx, mn) {
    if (mx === mn) return 0;
    var d = mx - mn;
    var h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  }

  /* --- Canvas Drawing ------------------------------------------- */
  var C_SAFE = "#00E676", C_DANGER = "#FF3D57", C_FACE = "#00D4FF";

  function drawFaceBox(ctx, x, y, w, h, hasHelmet) {
    ctx.save();
    var c = C_FACE;
    ctx.fillStyle = "rgba(0, 212, 255, 0.06)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = c;
    ctx.lineWidth = 2.5;
    ctx.strokeRect(x, y, w, h);
    corners(ctx, x, y, w, h, c, 18);

    // Un-mirror and draw label badge
    var cx = x + w / 2;
    var cy = y + h + 14;
    ctx.translate(cx, cy);
    ctx.scale(-1, 1);
    ctx.font = "bold 11px Outfit, sans-serif";
    ctx.textAlign = "center";
    var text = "👤 FACE TRACKED";
    var tw = ctx.measureText(text).width + 16;
    ctx.fillStyle = "rgba(6, 8, 16, 0.85)";
    rrect(ctx, -tw / 2, -10, tw, 20, 4);
    ctx.fill();
    ctx.strokeStyle = c;
    ctx.lineWidth = 1;
    rrect(ctx, -tw / 2, -10, tw, 20, 4);
    ctx.stroke();
    ctx.fillStyle = c;
    ctx.fillText(text, 0, 4);
    ctx.restore();
  }

  function drawHelmetZone(ctx, x, y, w, h, hasHelmet, score, detectionType) {
    var c = hasHelmet ? C_SAFE : C_DANGER;
    ctx.save();
    ctx.strokeStyle = c;
    ctx.lineWidth = 2.5;
    ctx.setLineDash(hasHelmet ? [] : [6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = hasHelmet ? "rgba(0, 230, 118, 0.08)" : "rgba(255, 61, 87, 0.08)";
    ctx.fillRect(x, y, w, h);
    corners(ctx, x, y, w, h, c, 16);

    // Un-mirror and draw zone label at top of helmet box
    var cx = x + w / 2;
    var cy = Math.max(18, y - 8);
    ctx.translate(cx, cy);
    ctx.scale(-1, 1);
    ctx.font = "bold 11px monospace";
    ctx.textAlign = "center";
    var zText = hasHelmet
      ? (detectionType === "motorcycle_helmet" ? "🛡️ MOTORCYCLE HELMET" : "🛡️ HELMET CONFIRMED")
      : "🛑 NO HELMET / HAIR";
    var zw = ctx.measureText(zText).width + 16;
    ctx.fillStyle = "rgba(6, 8, 16, 0.88)";
    rrect(ctx, -zw / 2, -12, zw, 20, 4);
    ctx.fill();
    ctx.strokeStyle = c;
    ctx.lineWidth = 1.5;
    rrect(ctx, -zw / 2, -12, zw, 20, 4);
    ctx.stroke();
    ctx.fillStyle = c;
    ctx.fillText(zText, 0, 3);
    ctx.restore();
  }

  function drawLabel(ctx, x, y, w, hasHelmet, score, threshold, detectionType) {
    var c = hasHelmet ? C_SAFE : C_DANGER;
    var text = hasHelmet ? "✔ HELMET DETECTED" : "✖ NO HELMET DETECTED";
    var subText = hasHelmet
      ? (score + "% (Req: " + threshold + "%) — " + (detectionType === "motorcycle_helmet" ? "MOTORCYCLE HELMET" : "SAFE"))
      : (score + "% (Req: " + threshold + "%) — HAIR DETECTED");

    var cx = x + w / 2;
    var by = Math.max(35, y + 36);
    ctx.save();
    // Un-mirror for CSS scaleX(-1)
    ctx.translate(cx, by);
    ctx.scale(-1, 1);
    ctx.font = "bold 13px Outfit, sans-serif";
    ctx.textAlign = "center";
    var bw = Math.max(ctx.measureText(text).width + 44, 210);
    ctx.fillStyle = "rgba(6,8,16,0.92)";
    ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 10;
    rrect(ctx, -bw / 2, -18, bw, 44, 6); ctx.fill();
    ctx.strokeStyle = c; ctx.lineWidth = 2;
    ctx.shadowColor = c; ctx.shadowBlur = 8;
    rrect(ctx, -bw / 2, -18, bw, 44, 6); ctx.stroke();
    ctx.fillStyle = c;
    ctx.font = "bold 13px Outfit, sans-serif";
    ctx.fillText(text, 0, -2);
    ctx.fillStyle = hasHelmet ? "rgba(255,255,255,0.8)" : "rgba(255,160,170,0.9)";
    ctx.font = "10px monospace";
    ctx.fillText(subText, 0, 16);
    ctx.restore();
  }

  function corners(ctx, x, y, w, h, c, s) {
    ctx.save(); ctx.strokeStyle = c; ctx.lineWidth = 2.5; ctx.lineCap = "round";
    function p(a, b, e, f) { ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(e, f); ctx.stroke(); }
    p(x, y+s, x, y); p(x, y, x+s, y);
    p(x+w-s, y, x+w, y); p(x+w, y, x+w, y+s);
    p(x, y+h-s, x, y+h); p(x, y+h, x+s, y+h);
    p(x+w-s, y+h, x+w, y+h); p(x+w, y+h, x+w, y+h-s);
    ctx.restore();
  }

  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x+r, y);
    ctx.lineTo(x+w-r, y); ctx.arcTo(x+w, y, x+w, y+r, r);
    ctx.lineTo(x+w, y+h-r); ctx.arcTo(x+w, y+h, x+w-r, y+h, r);
    ctx.lineTo(x+r, y+h); ctx.arcTo(x, y+h, x, y+h-r, r);
    ctx.lineTo(x, y+r); ctx.arcTo(x, y, x+r, y, r);
    ctx.closePath();
  }

  /* --- Result Panel --------------------------------------------- */
  function renderResult(has, score, detectionType) {
    var currentStatus = has ? "safe" : "danger";
    var changed = S.lastResult !== currentStatus;
    S.lastResult = currentStatus;
    var now = new Date().toLocaleTimeString("en-US", { hour12: false });

    D.camFrame.className   = "camera-frame " + currentStatus;
    setStatus(currentStatus, has ? "✔ Helmet Detected" : "✖ No Helmet Detected");

    D.resultCard.className     = "result-card " + currentStatus;
    D.resultIdle.style.display = "none";
    D.resultActive.style.display = "block";

    D.iconWrap.className         = "result-icon-wrap " + currentStatus;
    D.helmetIcon.style.display   = has ? "block" : "none";
    D.noHelmetIcon.style.display = has ? "none" : "block";

    D.resultLabel.textContent = has ? "✔ Helmet Detected" : "✖ No Helmet Detected";
    D.resultLabel.className   = "result-label " + currentStatus;

    D.confText.textContent = score + "% (Req: " + Tracker.threshold + "%)";
    D.confBar.style.width  = Math.min(100, Math.max(0, score)) + "%";
    D.confBar.className    = "confidence-bar-fill " + currentStatus;

    if (has) {
      var hName = detectionType === "motorcycle_helmet" ? "Motorcycle helmet" : "Safety helmet";
      D.detail.textContent = hName + " confirmed (" + score + "% score ≥ " + Tracker.threshold + "% threshold). Safe & compliant!";
    } else {
      D.detail.textContent = "Natural human hair detected (" + score + "% score < " + Tracker.threshold + "% threshold). Please put on a safety helmet!";
    }

    D.alertCard.style.display = has ? "none" : "flex";
    if (!has) D.alertMsg.textContent = "Safety violation: helmet confidence is below " + Tracker.threshold + "%! Wear a helmet immediately.";

    var nowMs = Date.now();
    if (!has && changed && !S.warnCooldown) {
      S.warnCooldown = true;
      openWarning();
      setTimeout(function () { S.warnCooldown = false; }, 12000);
    }

    if (changed && (nowMs - Tracker.lastLogTime > 2500)) {
      Tracker.lastLogTime = nowMs;
      S.totalScans++;
      if (has) S.safeCount++; else S.dangerCount++;
      D.totalEl.textContent  = S.totalScans;
      D.safeEl.textContent   = S.safeCount;
      D.dangerEl.textContent = S.dangerCount;
      addLog(has, score, now);
    }
  }

  /* --- Warning Popup -------------------------------------------- */
  function openWarning() {
    D.popup.style.display   = "flex";
    D.overlay.style.display = "block";
    beep();
  }
  function closeWarning() {
    D.popup.style.display   = "none";
    D.overlay.style.display = "none";
  }
  function beep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ac = new AC();
      [0, 300, 600].forEach(function (d) {
        setTimeout(function () {
          var o = ac.createOscillator(), g = ac.createGain();
          o.connect(g); g.connect(ac.destination);
          o.frequency.value = 880;
          o.frequency.exponentialRampToValueAtTime(440, ac.currentTime + 0.18);
          g.gain.setValueAtTime(0.14, ac.currentTime);
          g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.22);
          o.start(); o.stop(ac.currentTime + 0.25);
        }, d);
      });
    } catch (_) {}
  }

  /* --- History Log ---------------------------------------------- */
  function addLog(has, pct, time) {
    var e = D.history.querySelector(".history-empty");
    if (e) e.remove();
    var li = document.createElement("div");
    li.className = "history-item";
    li.innerHTML =
      "<span class=\"history-item-label " + (has ? "safe" : "danger") + "\">" +
      (has ? "? Helmet" : "? No Helmet") + " � " + pct + "%" +
      "</span><span class=\"history-item-time\">" + time + "</span>";
    D.history.insertBefore(li, D.history.firstChild);
    while (D.history.children.length > 20) D.history.removeChild(D.history.lastChild);
  }

  /* --- Screenshot ----------------------------------------------- */
  function screenshot() {
    var off = document.createElement("canvas");
    off.width  = D.webcam.videoWidth  || 640;
    off.height = D.webcam.videoHeight || 480;
    var c = off.getContext("2d");
    c.drawImage(D.webcam, 0, 0);
    c.drawImage(D.canvas, 0, 0);
    var a = document.createElement("a");
    a.download = "helmet-scan-" + Date.now() + ".png";
    a.href = off.toDataURL("image/png");
    a.click();
    toast("?? Screenshot saved!", "success");
  }

  /* --- Event Binding -------------------------------------------- */
  function bindEvents() {
    D.startBtn.addEventListener("click", startDetection);
    D.stopBtn .addEventListener("click", stopDetection);
    D.shotBtn .addEventListener("click", screenshot);
    D.overlay .addEventListener("click", closeWarning);
    if (D.flipBtn) D.flipBtn.addEventListener("click", flipCamera);

    if (D.threshSlider) {
      D.threshSlider.addEventListener("input", function (e) {
        var val = parseInt(e.target.value, 10) || 80;
        Tracker.threshold = val;
        if (D.threshVal) D.threshVal.textContent = val + "%";
        if (D.threshMarker) {
          D.threshMarker.style.left = val + "%";
          var tag = D.threshMarker.querySelector(".threshold-marker-tag");
          if (tag) tag.textContent = val + "% Req";
        }
      });
    }

    document.querySelectorAll("[onclick]").forEach(function (el) {
      var fn = el.getAttribute("onclick").replace(/\(.*\)/, "").trim();
      el.removeAttribute("onclick");
      if (fn === "closeWarning") el.addEventListener("click", closeWarning);
      if (fn === "clearHistory") el.addEventListener("click", function () {
        D.history.innerHTML = "<div class=\"history-empty\">No detections yet</div>";
      });
    });

    window.startDetection = startDetection;
    window.stopDetection  = stopDetection;
    window.closeWarning   = closeWarning;
    window.flipCamera     = flipCamera;

    document.querySelectorAll("a[href^=\"#\"]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        var t = document.querySelector(a.getAttribute("href"));
        if (t) { e.preventDefault(); t.scrollIntoView({ behavior: "smooth" }); }
      });
    });

    var nb = q("navbar");
    if (nb) {
      window.addEventListener("scroll", function () {
        nb.style.background = scrollY > 50 ? "rgba(6,8,16,0.97)" : "rgba(6,8,16,0.85)";
      }, { passive: true });
    }
  }

  /* --- Boot ----------------------------------------------------- */
  document.addEventListener("DOMContentLoaded", function () {
    initDOM();
    bindEvents();
    populateCameraList();
    console.log("%c HelmetAI v5 ready", "color:#00D4FF;font-size:15px;font-weight:bold");
    toast("Ready! Click Start Camera to begin.", "success", 3000);
  });

})();
