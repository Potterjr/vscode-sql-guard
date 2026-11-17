'use strict';

// Runs via the `vscode:uninstall` hook (plain Node, no vscode API) after SQL Guard is uninstalled:
// puts mssql's own Execute Query button/menus back.

const fs = require('fs');
const path = require('path');
const { setMssqlRunHidden } = require('./mssqlMenus');

const extensionsDir = path.resolve(__dirname, '..');
for (const dir of fs.readdirSync(extensionsDir)) {
    if (!dir.startsWith('ms-mssql.mssql-')) continue;
    try {
        setMssqlRunHidden(path.join(extensionsDir, dir), false);
    } catch (err) {
        console.error(`sql-guard: could not restore ${dir}: ${err.message}`);
    }
}
