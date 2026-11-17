'use strict';

const vscode = require('vscode');
const { analyze } = require('./analyzer');
const { setMssqlRunHidden } = require('./mssqlMenus');
const { findSections, groupSections } = require('./sections');

const MSSQL_ID = 'ms-mssql.mssql';
const RUN_ANYWAY = 'รันต่อ (Run anyway)';
const RELOAD = 'Reload Window';
const MAX_LISTED = 8;
// mssql reports a burst (e.g. disconnect + connect) when the connection changes; rebuild once after it settles.
const REBUILD_DELAY_MS = 300;
// mssql also reports a change when you switch to a tab on another connection — that needs no rebuild.
const EDITOR_SWITCH_MS = 100;
const TREE_REFRESH_MS = 200;
const TOOLTIP_LINES = 8;

async function runQuerySafe() {
    const editor = vscode.window.activeTextEditor;
    // Multi-cursor / no editor: let mssql show its own error.
    if (editor && editor.selections.length === 1) {
        const { document, selection } = editor;
        const text = selection.isEmpty ? document.getText() : document.getText(selection);
        const offset = selection.isEmpty ? 0 : document.offsetAt(selection.start);
        const findings = analyze(text);

        if (findings.length > 0) {
            const lines = findings.slice(0, MAX_LISTED).map(f => {
                const line = document.positionAt(offset + f.start).line + 1;
                return `บรรทัด ${line}: ${f.message}\n    ${f.snippet}`;
            });
            if (findings.length > MAX_LISTED) {
                lines.push(`... และอีก ${findings.length - MAX_LISTED} จุด`);
            }
            const choice = await vscode.window.showWarningMessage(
                `⚠️ พบคำสั่งที่อาจกระทบข้อมูลทั้งตาราง ${findings.length} จุด`,
                { modal: true, detail: lines.join('\n\n') + '\n\nต้องการรันต่อหรือไม่?' },
                RUN_ANYWAY
            );
            if (choice !== RUN_ANYWAY) {
                return;
            }
        }
    }
    await vscode.commands.executeCommand('mssql.runQuery');
}

// Selects the body of the `-- #region` at headerLine and runs it through the guard.
async function runSection(uri, headerLine) {
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    const section = findSections(document.getText()).find(s => s.headerLine === headerLine);
    if (!section) {
        return;
    }
    const start = new vscode.Position(section.headerLine + 1, 0);
    const end = section.endLine < document.lineCount
        ? new vscode.Position(section.endLine, 0)
        : document.lineAt(document.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(start, end);
    await runQuerySafe();
}

const sectionCodeLenses = {
    provideCodeLenses(document) {
        return findSections(document.getText()).map(s => new vscode.CodeLens(
            document.lineAt(s.headerLine).range,
            { title: '$(play) Run', tooltip: `รัน "${s.name}" ผ่าน SQL Guard`, command: 'sqlGuard.runSection', arguments: [document.uri, s.headerLine] }
        ));
    },
};

// Lists regions in Outline / breadcrumbs / Cmd+Shift+O like functions.
const sectionSymbols = {
    provideDocumentSymbols(document) {
        return findSections(document.getText()).map(s => {
            const last = Math.min(s.endLine, document.lineCount - 1);
            return new vscode.DocumentSymbol(
                s.name, '', vscode.SymbolKind.Function,
                new vscode.Range(s.headerLine, 0, last, document.lineAt(last).text.length),
                document.lineAt(s.headerLine).range
            );
        });
    },
};

// Sidebar "SQL Regions": the last active .sql file's regions, filed under its `-- ==== Name ====` lines,
// each with an inline ▶ that runs it through the guard. Elements are groupSections() objects.
const regionTree = {
    document: undefined,
    view: undefined,
    emitter: new vscode.EventEmitter(),
    get onDidChangeTreeData() {
        return this.emitter.event;
    },
    show(document) {
        this.document = document;
        if (this.view) {
            this.view.description = document ? vscode.workspace.asRelativePath(document.uri) : undefined;
        }
        vscode.commands.executeCommand('setContext', 'sqlGuard.hasSqlDocument', !!document);
        this.emitter.fire();
    },
    getChildren(node) {
        if (node) {
            return node.sections;
        }
        if (!this.document) {
            return [];
        }
        const { ungrouped, groups } = groupSections(this.document.getText());
        return [...ungrouped, ...groups];
    },
    getTreeItem(node) {
        if (node.sections) {
            const item = new vscode.TreeItem(node.name, node.sections.length > 0
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('folder');
            return item;
        }
        const { uri } = this.document;
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = 'sqlRegion';
        item.iconPath = new vscode.ThemeIcon('symbol-function');
        const last = Math.min(node.endLine, node.headerLine + 1 + TOOLTIP_LINES);
        const body = this.document.getText(new vscode.Range(node.headerLine + 1, 0, last, 0)).trimEnd();
        item.tooltip = new vscode.MarkdownString().appendCodeblock(body, 'sql');
        item.command = { command: 'sqlGuard.revealSection', title: 'ไปที่ region', arguments: [uri, node.headerLine] };
        return item;
    },
};

// Puts the cursor on a region's header line and scrolls it to the top.
async function revealSection(uri, headerLine) {
    const editor = await vscode.window.showTextDocument(uri);
    const header = new vscode.Position(headerLine, 0);
    editor.selection = new vscode.Selection(header, header);
    editor.revealRange(new vscode.Range(header, header), vscode.TextEditorRevealType.AtTop);
}

function registerRegionTree(context) {
    regionTree.view = vscode.window.createTreeView('sqlGuard.regions', { treeDataProvider: regionTree, showCollapseAll: true });
    const showIfSql = editor => {
        if (editor?.document.languageId === 'sql') {
            regionTree.show(editor.document);
        }
    };
    showIfSql(vscode.window.activeTextEditor);
    let timer;
    context.subscriptions.push(
        regionTree.view,
        vscode.window.onDidChangeActiveTextEditor(showIfSql),
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document === regionTree.document) {
                clearTimeout(timer);
                timer = setTimeout(() => regionTree.show(e.document), TREE_REFRESH_MS);
            }
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            if (document === regionTree.document) {
                regionTree.show(undefined);
            }
        }),
        { dispose: () => clearTimeout(timer) },
        vscode.commands.registerCommand('sqlGuard.revealSection', revealSection),
        vscode.commands.registerCommand('sqlGuard.runRegionNode', node => regionTree.document && runSection(regionTree.document.uri, node.headerLine))
    );
}

// Applies the sqlGuard.hideMssqlExecute setting to mssql's own Execute Query menus.
async function syncMssqlMenus() {
    const mssql = vscode.extensions.getExtension(MSSQL_ID);
    if (!mssql) {
        return;
    }
    const hide = vscode.workspace.getConfiguration('sqlGuard').get('hideMssqlExecute', true);
    let changed;
    try {
        changed = setMssqlRunHidden(mssql.extensionPath, hide);
    } catch (err) {
        vscode.window.showErrorMessage(`SQL Guard: แก้เมนู Execute Query ของ mssql ไม่สำเร็จ — ${err.message}`);
        return;
    }
    if (changed) {
        const done = hide ? 'ซ่อนปุ่ม Execute Query เดิมของ mssql แล้ว' : 'คืนปุ่ม Execute Query เดิมของ mssql แล้ว';
        const choice = await vscode.window.showInformationMessage(`SQL Guard: ${done} — Reload Window เพื่อให้มีผล`, RELOAD);
        if (choice === RELOAD) {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    }
}

// Rebuilds mssql's IntelliSense cache when the active .sql editor's connection or database changes
// (USE, Change Database, Change Connection) — otherwise it keeps flagging names against the old database.
let watchingConnections = false;

async function watchConnectionChanges(context) {
    const mssql = vscode.extensions.getExtension(MSSQL_ID);
    if (watchingConnections || !mssql) {
        return;
    }
    watchingConnections = true;
    let api;
    try {
        api = (await mssql.activate()).getSharedConnectionsApi(1);
    } catch {
        return; // mssql without the shared connections API: Cmd+Shift+R still rebuilds by hand
    }
    let lastEditorSwitch = 0;
    let timer;
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => { lastEditorSwitch = Date.now(); }),
        api.onDidChangeActiveEditorConnection(() => {
            const firedAt = Date.now();
            clearTimeout(timer);
            timer = setTimeout(() => {
                const editor = vscode.window.activeTextEditor;
                if (Math.abs(firedAt - lastEditorSwitch) < EDITOR_SWITCH_MS
                    || editor?.document.languageId !== 'sql'
                    || !vscode.workspace.getConfiguration('sqlGuard').get('autoRefreshIntelliSense', true)) {
                    return;
                }
                vscode.commands.executeCommand('mssql.rebuildIntelliSenseCache');
            }, REBUILD_DELAY_MS);
        }),
        { dispose: () => clearTimeout(timer) }
    );
}

function activate(context) {
    // Hook mssql once a .sql file is open rather than activating it in every window.
    const watchIfSql = doc => {
        if (doc.languageId === 'sql') {
            watchConnectionChanges(context);
        }
    };
    vscode.workspace.textDocuments.forEach(watchIfSql);
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(watchIfSql),
        vscode.commands.registerCommand('sqlGuard.runQuery', runQuerySafe),
        vscode.commands.registerCommand('sqlGuard.runSection', runSection),
        vscode.languages.registerCodeLensProvider({ language: 'sql' }, sectionCodeLenses),
        vscode.languages.registerDocumentSymbolProvider({ language: 'sql' }, sectionSymbols),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('sqlGuard.hideMssqlExecute')) {
                syncMssqlMenus();
            }
        })
    );
    registerRegionTree(context);
    syncMssqlMenus();
}

function deactivate() {}

module.exports = { activate, deactivate };
