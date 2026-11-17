'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setMssqlRunHidden, RUN_COMMANDS } = require('../mssqlMenus');

const manifest = {
    name: 'mssql',
    contributes: {
        menus: {
            'editor/title': [
                { command: 'mssql.runQuery', when: 'editorLangId == sql', group: 'navigation@1' },
                { command: 'mssql.runQueryWithUriOwnership', when: 'editorLangId == sql', group: 'navigation@1' },
                { command: 'mssql.connect', when: 'editorLangId == sql', group: 'navigation@3' },
            ],
            'editor/context': [
                { command: 'mssql.runQuery', when: 'editorLangId == sql', group: '0_mssql' },
                { command: 'mssql.changeConnection', when: 'editorLangId == sql', group: '0_mssql' },
            ],
            commandPalette: [
                { command: 'mssql.runQueryWithUriOwnership', when: 'false' },
                { command: 'mssql.quickQueries.run1' },
            ],
        },
    },
};

function fakeExtension() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-guard-test-'));
    const original = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(path.join(dir, 'package.json'), original);
    return { dir, original, read: () => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) };
}

test('hides only the Execute Query entries', () => {
    const ext = fakeExtension();
    assert.strictEqual(setMssqlRunHidden(ext.dir, true), true);

    const menus = ext.read().contributes.menus;
    for (const item of [...menus['editor/title'], ...menus['editor/context']]) {
        assert.strictEqual(item.when, RUN_COMMANDS.includes(item.command) ? 'false' : 'editorLangId == sql');
    }
    for (const command of RUN_COMMANDS) {
        assert.deepStrictEqual(menus.commandPalette.filter(i => i.command === command), [{ command, when: 'false' }]);
    }
    assert.ok(menus.commandPalette.some(i => i.command === 'mssql.quickQueries.run1'));
});

test('is idempotent and restores the original byte-for-byte', () => {
    const ext = fakeExtension();
    assert.strictEqual(setMssqlRunHidden(ext.dir, true), true);
    assert.strictEqual(setMssqlRunHidden(ext.dir, true), false);

    assert.strictEqual(setMssqlRunHidden(ext.dir, false), true);
    assert.strictEqual(fs.readFileSync(path.join(ext.dir, 'package.json'), 'utf8'), ext.original);
    assert.strictEqual(fs.existsSync(path.join(ext.dir, 'package.json.sql-guard-backup')), false);
    assert.strictEqual(setMssqlRunHidden(ext.dir, false), false);
});
