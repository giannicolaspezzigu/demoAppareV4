// water.js – effetto acqua stile WaterPanel2 (versione semplice e robusta)

const canvas = document.getElementById("waterCanvas");
// willReadFrequently migliora le performance dei getImageData
const ctx = canvas.getContext("2d", { willReadFrequently: true });

let width  = window.innerWidth;
let height = window.innerHeight;
let hwidth  = width  >> 1;
let hheight = height >> 1;

let ripplePrev = null;
let rippleCurr = null;

// texture originale (immagine di sfondo)
let textureImageData = null;
let textureData = null;

// buffer per il frame deformato
let frameImageData = null;
let frameData = null;

const DAMPING_SHIFT = 5;
const SCALE         = 1024;

function resizeCanvas() {
  width  = window.innerWidth;
  height = window.innerHeight;
  hwidth  = width  >> 1;
  hheight = height >> 1;

  canvas.width  = width;
  canvas.height = height;

  if (bgLoaded) {
    drawBackground();
    grabTexture();
  }
}

window.addEventListener("resize", resizeCanvas);

// ---------- CARICAMENTO SFONDO ----------

let bgLoaded = false;
const bgImg = new Image();

// IMPORTANTISSIMO: prima i listener, poi src
bgImg.onload = () => {
  bgLoaded = true;
  console.log("Background caricato");
  resizeCanvas();
  drawBackground();
  grabTexture();
  disturb(width / 2, height / 2, 20, 900); // piccola onda iniziale
  attachMouse();
  requestAnimationFrame(loop);
};

bgImg.onerror = () => {
  bgLoaded = true;
  console.warn("background.jpg non caricato, uso gradiente");
  resizeCanvas();
  drawFallbackGradient();
  grabTexture();
  disturb(width / 2, height / 2, 20, 900);
  attachMouse();
  requestAnimationFrame(loop);
};

// deve essere nello stesso path di landing.html
bgImg.src = "landing/background.jpg";

function drawBackground() {
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(bgImg, 0, 0, width, height);
}

function drawFallbackGradient() {
  const grd = ctx.createLinearGradient(0, 0, 0, height);
  grd.addColorStop(0,   "#0f172a");
  grd.addColorStop(0.4, "#1d4ed8");
  grd.addColorStop(1,   "#e0f2fe");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, width, height);
}

// cattura la texture di base e prepara i buffer
function grabTexture() {
  textureImageData = ctx.getImageData(0, 0, width, height);
  textureData = textureImageData.data;        // Uint8ClampedArray
  frameImageData = ctx.createImageData(width, height);
  frameData = frameImageData.data;

  ripplePrev = new Int16Array(width * height);
  rippleCurr = new Int16Array(width * height);
}

// ---------- SIMULAZIONE ONDE ----------

function idx(x, y) {
  return y * width + x;
}

function disturb(cx, cy, radius = 7, power = 512) {
  if (!ripplePrev) return;

  cx |= 0;
  cy |= 0;
  const r2 = radius * radius;

  for (let y = cy - radius; y < cy + radius; y++) {
    if (y <= 0 || y >= height - 1) continue;
    for (let x = cx - radius; x < cx + radius; x++) {
      if (x <= 0 || x >= width - 1) continue;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy < r2) {
        ripplePrev[idx(x, y)] += power;
      }
    }
  }
}

function newFrame() {
  if (!ripplePrev || !rippleCurr) return;

  const w = width;
  const h = height;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = idx(x, y);

      const val =
        (ripplePrev[i - 1] +
         ripplePrev[i + 1] +
         ripplePrev[i - w] +
         ripplePrev[i + w]) >> 1;

      let data = val - rippleCurr[i];
      data -= data >> DAMPING_SHIFT;
      rippleCurr[i] = data;
    }
  }

  // swap buffer
  const tmp = ripplePrev;
  ripplePrev = rippleCurr;
  rippleCurr = tmp;
}

function render() {
  if (!textureData || !ripplePrev || !frameData) return;

  const w = width;
  const h = height;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      let data = SCALE - ripplePrev[i];

      let a = ((x - hwidth) * data / SCALE + hwidth)  | 0;
      let b = ((y - hheight) * data / SCALE + hheight) | 0;

      if (a < 0) a = 0;
      if (a >= w) a = w - 1;
      if (b < 0) b = 0;
      if (b >= h) b = h - 1;

      const srcIndex = (b * w + a) * 4;
      const dstIndex = i * 4;

      frameData[dstIndex    ] = textureData[srcIndex    ]; // R
      frameData[dstIndex + 1] = textureData[srcIndex + 1]; // G
      frameData[dstIndex + 2] = textureData[srcIndex + 2]; // B
      frameData[dstIndex + 3] = textureData[srcIndex + 3]; // A
    }
  }

  ctx.putImageData(frameImageData, 0, 0);
}

function loop() {
  newFrame();
  render();
  requestAnimationFrame(loop);
}

// ---------- INPUT MOUSE / TOUCH ----------

// ---------- INPUT MOUSE / TOUCH ----------

function attachMouse() {
  // Usiamo l'overlay (che è sopra il canvas) come target degli eventi
  const target = document.querySelector(".launch-overlay") || canvas;

  let lastX = null;
  let lastY = null;

  function getNormCoords(clientX, clientY) {
    const rect = target.getBoundingClientRect();
    const x = (clientX - rect.left) * (width / rect.width);
    const y = (clientY - rect.top)  * (height / rect.height);
    return { x, y };
  }

  target.addEventListener("mousemove", e => {
    const { x, y } = getNormCoords(e.clientX, e.clientY);

    if (lastX === null || (Math.abs(x - lastX) + Math.abs(y - lastY)) > 3) {
      disturb(x, y, 7, 600);
      lastX = x;
      lastY = y;
    }
  });

  target.addEventListener("mousedown", e => {
    const { x, y } = getNormCoords(e.clientX, e.clientY);
    disturb(x, y, 10, 1400);
  });

  target.addEventListener("touchmove", e => {
    const touch = e.touches[0];
    if (!touch) return;

    const { x, y } = getNormCoords(touch.clientX, touch.clientY);
    disturb(x, y, 8, 800);
    e.preventDefault();
  }, { passive: false });
}
