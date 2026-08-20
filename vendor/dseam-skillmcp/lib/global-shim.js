/**
 * dseam-skillmcp —— 全局命令 shim 安装。
 *
 * profile 安装只会在 <profile>/node_modules/.bin 生成 dseam-skillmcp，该目录不在
 * 用户 PATH 中。宿主启动时把 shim 写入 npm 全局 bin 目录，使用户能在
 * PowerShell / CMD / bash 中直接调用 `dseam-skillmcp`。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
function globalBinDir() {
    if (process.platform === "win32") {
        const base = process.env.APPDATA || join(process.env.USERPROFILE ?? ".", "AppData", "Roaming");
        return join(base, "npm");
    }
    try {
        return execFileSync("npm", ["prefix", "-g"], { encoding: "utf8", windowsHide: true }).trim();
    }
    catch {
        return "/usr/local/bin";
    }
}
function writeIfChanged(path, content, mode) {
    const old = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (old === content)
        return false;
    writeFileSync(path, content, mode !== undefined ? { mode } : "utf8");
    if (mode !== undefined)
        chmodSync(path, mode);
    return true;
}
export function ensureGlobalShim(logger) {
    try {
        const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
        const binDir = globalBinDir();
        mkdirSync(binDir, { recursive: true });
        let changed = false;
        if (process.platform === "win32") {
            changed = writeIfChanged(join(binDir, "dseam-skillmcp.cmd"), `@ECHO off\r\nnode "${cliPath}" %*\r\n`) || changed;
            changed = writeIfChanged(join(binDir, "dseam-skillmcp.ps1"), `node "${cliPath}" @args\r\n`) || changed;
        }
        else {
            changed = writeIfChanged(join(binDir, "dseam-skillmcp"), `#!/bin/sh\nexec node "${cliPath}" "$@"\n`, 0o755) || changed;
        }
        const message = changed
            ? `installed global dseam-skillmcp shim at ${join(binDir, "dseam-skillmcp")}`
            : `global dseam-skillmcp shim already up to date at ${join(binDir, "dseam-skillmcp")}`;
        if (logger !== undefined)
            logger.info("[dseam-skillmcp] " + message);
        else
            console.log("[dseam-skillmcp] " + message);
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (logger !== undefined)
            logger.info("[dseam-skillmcp] unable to install global dseam-skillmcp shim: " + detail);
        else
            console.warn("[dseam-skillmcp] unable to install global dseam-skillmcp shim: " + detail);
    }
}
