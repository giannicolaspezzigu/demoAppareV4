// water.js – effetto acqua stile WaterPanel2 (versione stabile)

const canvas = document.getElementById("waterCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

let width  = window.innerWidth;
let height = window.innerHeight;
let hwidth  = width  >> 1;
let hheight = height >> 1;

let ripplePrev = null;
let rippleCurr = null;

let textureImageData = null;
let textureData = null;

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

bgImg.onload = () => {
  bgLoaded = true;
  resizeCanvas();
  drawBackground();
  grabTexture();
  disturb(width/2, height/2, 20, 900);
  attachMouse();
  requestAnimationFrame(loop);
};

bgImg.onerror = () => {
  bgLoaded = true;
  resizeCanvas();
  drawFallbackGradient();
  grabTexture();
  disturb(width/2, height/2, 20, 900);
  attachMouse();
  requestAnimationFrame(loop);
};

bgImg.src = "landing/background.jpg";

function drawBackground() {
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(bgImg, 0, 0, width, height);
}

function drawFallbackGradient() {
  const grd = ctx.createLinearGradient(0, 0, 0, height);
  grd.addColorStop(0, "#0f172a");
  grd.addColorStop(0.4, "#1d4ed8");
  grd.addColorStop(1, "#e0f2fe");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, width, height);
}

function grabTexture() {
  textureImageData = ctx.getImageData(0, 0, width, height);
  textureData = textureImageData.data;

  frameImageData = ctx.createImageData(width, height);
  frameData = frameImageData.data;

  ripplePrev = new Int16Array(width * height);
  rippleCurr = new Int16Array(width * height);
}

// ---------- SIMULAZIONE ----------

function idx(x, y) { return y * width + x; }

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
      if (dx * dx + dy * dy < r2) ripplePrev[idx(x, y)] += power;
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

  const tmp = ripplePrev;
  ripplePrev = rippleCurr;
  rippleCurr = tmp;
}

function render() {
  if (!textureData || !ripplePrev) return;

  const w = width;
  const h = height;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      const data = SCALE - ripplePrev[i];

      let a = ((x - hwidth) * data / SCALE + hwidth) | 0;
      let b = ((y - hheight) * data / SCALE + hheight) | 0;

      if (a < 0) a = 0;
      if (a >= w) a = w - 1;
      if (b < 0) b = 0;
      if (b >= h) b = h - 1;

      const src = (b * w + a) * 4;
      const dst = i * 4;

      frameData[dst]     = textureData[src];
      frameData[dst + 1] = textureData[src + 1];
      frameData[dst + 2] = textureData[src + 2];
      frameData[dst + 3] = 255;
    }
  }

  ctx.putImageData(frameImageData, 0, 0);
}

function loop() {
  newFrame();
  render();
  requestAnimationFrame(loop);
}

// ---------- INPUT ----------

function attachMouse() {
  const target = document.querySelector(".launch-overlay");

  let lastX = null, lastY = null;

  function coords(clientX, clientY) {
    const r = target.getBoundingClientRect();
    return {
      x: (clientX - r.left) * (width / r.width),
      y: (clientY - r.top)  * (height / r.height)
    };
  }

  target.addEventListener("mousemove", e => {
    const {x, y} = coords(e.clientX, e.clientY);
    if (lastX === null || Math.abs(x - lastX) + Math.abs(y - lastY) > 3) {
      disturb(x, y, 7, 600);
      lastX = x; lastY = y;
    }
  });

  target.addEventListener("mousedown", e => {
    const {x, y} = coords(e.clientX, e.clientY);
    disturb(x, y, 10, 1400);
  });

  target.addEventListener("touchmove", e => {
    const t = e.touches[0];
    if (!t) return;
    const {x, y} = coords(t.clientX, t.clientY);
    disturb(x, y, 8, 800);
    e.preventDefault();
  }, { passive: false });
}
