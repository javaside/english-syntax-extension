import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "../../manifest.json";
import packageJson from "../../package.json";

describe("manifest", () => {
  it("uses temporary page access and optional model hosts", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(["activeTab", "scripting", "storage", "contextMenus"]),
    );
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest.optional_host_permissions).toEqual([
      "https://*/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
    ]);
  });

  it("registers the hovered-block keyboard command", () => {
    expect(manifest.commands).toEqual({
      "parse-hovered-block": {
        suggested_key: { default: "Alt+T" },
        description: "解析鼠标悬停的段落",
      },
    });
  });

  it("ships every icon size Chrome asks for, and each file exists", () => {
    expect(manifest.icons).toEqual({
      "16": "assets/icon-16.png",
      "32": "assets/icon-32.png",
      "48": "assets/icon-48.png",
      "128": "assets/icon-128.png",
    });
    expect(manifest.action.default_icon).toEqual(manifest.icons);
    for (const path of Object.values(manifest.icons)) {
      // public/ 下才会被 Vite 复制成 dist/assets/，manifest 路径与之一致。
      expect(existsSync(resolve(import.meta.dirname, "../..", "public", path)), path).toBe(true);
    }
  });

  // 两处版本漂移过一次就再也说不清发的是哪一版。
  it("keeps the manifest and package versions identical", () => {
    expect(manifest.version).toBe(packageJson.version);
  });
});
