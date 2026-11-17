'use strict';

// Hides mssql's own Execute Query entry points (editor title ▶, right-click menu, Command Palette)
// by patching its package.json, so queries can only be run through SQL Guard.
// VS Code has no API to remove another extension's menu items. An mssql update installs a fresh
// copy, so the patch is re-applied on every startup. The original is kept next to it as a backup.

const fs = require('fs');
const path = require('path');

const RUN_COMMANDS = ['mssql.runQuery', 'mssql.runQueryWithUriOwnership'];
const BACKUP = 'package.json.sql-guard-backup';

function patch(json) {
    const pkg = JSON.parse(json);
    const menus = pkg.contributes.menus;
    for (const location of ['editor/title', 'editor/context']) {
        for (const item of menus[location] || []) {
            if (RUN_COMMANDS.includes(item.command)) item.when = 'false';
        }
    }
    menus.commandPalette = (menus.commandPalette || []).filter(item => !RUN_COMMANDS.includes(item.command));
    for (const command of RUN_COMMANDS) menus.commandPalette.push({ command, when: 'false' });
    return JSON.stringify(pkg, null, '\t');
}

/**
 * Hides (or restores) mssql's Execute Query menus in the extension at `extensionPath`.
 * @returns {boolean} true if package.json changed (a window reload is needed)
 */
function setMssqlRunHidden(extensionPath, hidden) {
    const file = path.join(extensionPath, 'package.json');
    const backup = path.join(extensionPath, BACKUP);
    const current = fs.readFileSync(file, 'utf8');

    if (!fs.existsSync(backup)) {
        if (!hidden) return false;
        fs.writeFileSync(backup, current);
    }
    const original = fs.readFileSync(backup, 'utf8');
    const wanted = hidden ? patch(original) : original;
    if (wanted === current) {
        if (!hidden) fs.unlinkSync(backup);
        return false;
    }
    fs.writeFileSync(file, wanted);
    if (!hidden) fs.unlinkSync(backup);
    return true;
}

module.exports = { setMssqlRunHidden, RUN_COMMANDS };
