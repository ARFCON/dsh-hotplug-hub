#!/usr/bin/env node
/**
 * dseam-skillmcp —— dseam-skillmcp 的统一命令行。
 *
 *   dseam-skillmcp skill ...      技能管理（原 dsh-skill 全部能力）
 *   dseam-skillmcp mcp ...        MCP 服务器管理（list / add / remove / enable / disable / test / update）
 *   dseam-skillmcp update         检查并更新整个 dseam-skillmcp 插件
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runSkillCli } from "./cli-skill.js";
import { runMcpCli } from "./cli-mcp.js";
import { currentVersion } from "./version.js";
function usage() {
    console.log([
        "用法:",
        "  dseam-skillmcp skill <command> [args]    技能管理（list / enable / disable / delete / add / scope / migrate / update）",
        "  dseam-skillmcp mcp <command> [args]      MCP 服务器管理（list / add / remove / enable / disable / test / update）",
        "  dseam-skillmcp update [--yes] [--profile <name>]",
        "                                      检查并更新 dseam-skillmcp",
        "  dseam-skillmcp --version                 显示当前版本",
        "",
        "技能命令帮助：dseam-skillmcp skill --help",
        "MCP 命令帮助：dseam-skillmcp mcp --help"
    ].join("\n"));
}
export async function runPanelCli(args) {
    const command = args[0];
    const rest = args.slice(1);
    if (command === undefined || command === "--help" || command === "-h" || command === "help") {
        usage();
        return command === undefined ? 2 : 0;
    }
    if (command === "--version" || command === "-V") {
        console.log("dseam-skillmcp v" + currentVersion());
        return 0;
    }
    if (command === "skill") {
        return runSkillCli(rest);
    }
    if (command === "update") {
        // 顶层 update 与 skill update 等价：更新的是同一个融合包。
        return runSkillCli(["update", ...rest]);
    }
    if (command === "mcp") {
        return runMcpCli(rest);
    }
    console.error('未知命令 "' + command + '"');
    usage();
    return 2;
}
const directPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
const modulePath = fileURLToPath(import.meta.url);
if (directPath !== undefined && (directPath === modulePath || resolve(directPath) === resolve(modulePath))) {
    runPanelCli(process.argv.slice(2)).then((code) => {
        if (code !== 0)
            process.exitCode = code;
    }).catch((error) => {
        console.error("dseam-skillmcp: " + (error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
    });
}
