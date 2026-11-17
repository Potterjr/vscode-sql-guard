'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { findSections, groupSections } = require('../sections');

test('finds named regions with their #endregion line', () => {
    const sql = [
        'SELECT 1',
        '-- #region 1) หา barcode',
        'SELECT 2',
        '-- #endregion',
        '  --#region   2) location  ',
        'SELECT 3',
        '--  #endregion',
    ].join('\n');
    assert.deepStrictEqual(findSections(sql), [
        { name: '1) หา barcode', headerLine: 1, endLine: 3 },
        { name: '2) location', headerLine: 4, endLine: 6 },
    ]);
});

test('handles nesting, unnamed and unclosed regions', () => {
    const sql = [
        '-- #region outer',
        '-- #region',
        'SELECT 1',
        '-- #endregion',
        '-- #endregion',
        '-- #region tail',
        'SELECT 2',
    ].join('\r\n');
    assert.deepStrictEqual(findSections(sql), [
        { name: 'outer', headerLine: 0, endLine: 4 },
        { name: 'บรรทัด 2', headerLine: 1, endLine: 3 },
        { name: 'tail', headerLine: 5, endLine: 7 },
    ]);
});

test('ignores look-alike comments and stray #endregion', () => {
    const sql = '-- #regional sales\n-- #endregion\n-- region x\nSELECT 1';
    assert.deepStrictEqual(findSections(sql), []);
});

test('files regions under the ==== group header above them', () => {
    const sql = [
        '-- #region setup',
        '-- #endregion',
        '-- ========== Inbound ==========',
        '-- #region 4) รับสินค้า',
        '-- #endregion',
        '-- #region 4.1) plan',
        '-- #endregion',
        '--==== Bin Balance ====',
        '-- ============',
        '-- ==== Empty ====',
    ].join('\n');
    assert.deepStrictEqual(groupSections(sql), {
        ungrouped: [{ name: 'setup', headerLine: 0, endLine: 1 }],
        groups: [
            {
                name: 'Inbound', line: 2, sections: [
                    { name: '4) รับสินค้า', headerLine: 3, endLine: 4 },
                    { name: '4.1) plan', headerLine: 5, endLine: 6 },
                ],
            },
            { name: 'Bin Balance', line: 7, sections: [] },
            { name: 'Empty', line: 9, sections: [] },
        ],
    });
});

test('a == comparison or short rule is not a group header', () => {
    const sql = "-- WHERE a == b\n-- == x ==\n-- ===\nSELECT '=== y ==='";
    assert.deepStrictEqual(groupSections(sql), { ungrouped: [], groups: [] });
});
