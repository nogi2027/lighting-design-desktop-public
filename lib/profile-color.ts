function clampHue(value: number) {
  const rounded = Math.round(Number.isFinite(value) ? value : 205);
  return ((rounded % 360) + 360) % 360;
}

export function hueToHex(value: number) {
  const hue = clampHue(value);
  const saturation = 0.78;
  const lightness = 0.62;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - chroma / 2;
  let channels: [number, number, number];
  if (hue < 60) channels = [chroma, x, 0];
  else if (hue < 120) channels = [x, chroma, 0];
  else if (hue < 180) channels = [0, chroma, x];
  else if (hue < 240) channels = [0, x, chroma];
  else if (hue < 300) channels = [x, 0, chroma];
  else channels = [chroma, 0, x];
  return `#${channels.map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function hexToHue(value: string) {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return 205;
  const number = Number.parseInt(match[1], 16);
  const red = ((number >> 16) & 255) / 255;
  const green = ((number >> 8) & 255) / 255;
  const blue = (number & 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  if (delta === 0) return 205;
  let hue: number;
  if (max === red) hue = 60 * (((green - blue) / delta) % 6);
  else if (max === green) hue = 60 * ((blue - red) / delta + 2);
  else hue = 60 * ((red - green) / delta + 4);
  return clampHue(hue);
}
