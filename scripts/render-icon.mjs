import { _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const data = await fs.mkdtemp(path.join(os.tmpdir(), "lx-icon-"));
const app = await electron.launch({
  executablePath: require("electron"),
  args: [process.cwd()],
  env: { ...process.env, LX_DESKTOP_USER_DATA: data },
});
try {
  const page = await app.firstWindow();
  const png = await page.evaluate(async () => {
    const image = new Image();
    image.src = "app://desktop/icon.svg";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1024;
    canvas.getContext("2d").drawImage(image, 0, 0, 1024, 1024);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await fs.mkdir("build", { recursive: true });
  await fs.writeFile("build/icon.png", Buffer.from(png, "base64"));
} finally {
  await app.evaluate(({ app }) => app.exit(0));
}
