'use strict';
// infra/cmd-special.js — Windows cmd.exe 包装专用特殊字符集（launcher 唯一真源）
//
// 注意：这是"经 cmd.exe /c 包装执行"场景的 cmd 元字符集（& | < > ^ % ( ) ! "），
// 与契约常量 CMD_SPECIAL_RE（packages/shared-core/security/shell.js，POSIX shell
// 注入集 + 控制字符）同名不同值——二者用途不同，绝不能混用或互相覆盖。
// 命名以 CMD_EXE_ 前缀显式区分（审计：dsh-cli.js / launch.js / install.js 曾各自
// 重复定义同名常量，属高混淆/漂移风险，收敛于此）。
const CMD_EXE_SPECIAL_RE = /[&|<>^%()!"]/;

module.exports = { CMD_EXE_SPECIAL_RE };
