'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { analyze } = require('../analyzer');

const kinds = sql => analyze(sql).map(f => f.kind);

test('flags UPDATE/DELETE without WHERE', () => {
    assert.deepStrictEqual(kinds('UPDATE ms_Product SET Flag_MultiPack = 1'), ['UPDATE']);
    assert.deepStrictEqual(kinds('delete from ms_Product'), ['DELETE']);
    assert.deepStrictEqual(kinds('DELETE ms_Product'), ['DELETE']);
    assert.deepStrictEqual(kinds('DELETE TOP (10) FROM ms_Product'), ['DELETE']);
    assert.deepStrictEqual(kinds('UPDATE a SET x = 1 FROM a JOIN b ON a.id = b.id'), ['UPDATE']);
});

test('allows UPDATE/DELETE with WHERE', () => {
    assert.deepStrictEqual(kinds("UPDATE ms_Product SET Flag_MultiPack = 1 WHERE Product_Id = 'A'"), []);
    assert.deepStrictEqual(kinds("DELETE FROM [Dohome.WCC.Master.DB].[dbo].[ms_Product] WHERE Product_Id = 'A';"), []);
    assert.deepStrictEqual(kinds('UPDATE t WITH (ROWLOCK) SET a = 1 WHERE id = 1'), []);
    assert.deepStrictEqual(kinds('UPDATE t SET a = CASE WHEN b = 1 THEN 2 ELSE 3 END WHERE id = 1'), []);
    assert.deepStrictEqual(kinds('UPDATE t SET a = 1 OUTPUT inserted.* WHERE id = 1'), []);
    assert.deepStrictEqual(kinds('WITH x AS (SELECT * FROM t) DELETE FROM x WHERE rn > 1'), []);
});

test('WHERE in a subquery or a later statement does not count', () => {
    assert.deepStrictEqual(kinds('UPDATE t SET a = (SELECT max(b) FROM u WHERE u.id = 1)'), ['UPDATE']);
    assert.deepStrictEqual(kinds('DELETE FROM t\nSELECT * FROM u WHERE id = 1'), ['DELETE']);
    assert.deepStrictEqual(kinds('UPDATE t SET a = 1;\nSELECT * FROM u WHERE id = 1'), ['UPDATE']);
    assert.deepStrictEqual(kinds('DELETE FROM t\nGO\nSELECT * FROM u WHERE id = 1'), ['DELETE']);
    assert.deepStrictEqual(kinds('BEGIN TRAN\nDELETE FROM t\nEND'), ['DELETE']);
});

test('ignores comments and strings', () => {
    assert.deepStrictEqual(kinds('-- DELETE FROM t\nSELECT 1'), []);
    assert.deepStrictEqual(kinds('/* UPDATE t SET a = 1 /* nested */ DROP TABLE t */ SELECT 1'), []);
    assert.deepStrictEqual(kinds("SELECT 'DELETE FROM t', N'DROP TABLE x'"), []);
    assert.deepStrictEqual(kinds('DELETE FROM t -- WHERE id = 1'), ['DELETE']);
    assert.deepStrictEqual(kinds('SELECT [delete], [update] FROM t'), []);
});

test('flags DROP and TRUNCATE, except temp tables', () => {
    assert.deepStrictEqual(kinds('DROP TABLE ms_Product'), ['DROP']);
    assert.deepStrictEqual(kinds('DROP TABLE IF EXISTS dbo.x'), ['DROP']);
    assert.deepStrictEqual(kinds('ALTER TABLE t DROP COLUMN c'), ['DROP']);
    assert.deepStrictEqual(kinds('TRUNCATE TABLE wm_BinBalance'), ['TRUNCATE']);
    assert.deepStrictEqual(kinds('DROP TABLE #tmp'), []);
    assert.deepStrictEqual(kinds('DROP TABLE IF EXISTS #tmp'), []);
    assert.deepStrictEqual(kinds('TRUNCATE TABLE #tmp'), []);
});

test('ignores non-DML uses of UPDATE/DELETE', () => {
    assert.deepStrictEqual(kinds('UPDATE STATISTICS dbo.t'), []);
    assert.deepStrictEqual(kinds('GRANT SELECT, UPDATE, DELETE ON t TO u'), []);
    assert.deepStrictEqual(kinds('ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u(a) ON DELETE CASCADE ON UPDATE NO ACTION'), []);
    assert.deepStrictEqual(kinds('MERGE t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a WHEN NOT MATCHED BY SOURCE THEN DELETE;'), []);
});

test('ignores bodies of procedures/triggers being defined', () => {
    assert.deepStrictEqual(kinds('CREATE PROCEDURE p AS\nDELETE FROM t\nGO'), []);
    assert.deepStrictEqual(kinds('CREATE OR ALTER TRIGGER tr ON t AFTER INSERT, UPDATE AS\nIF UPDATE(a) UPDATE t SET b = 1\nGO\nDELETE FROM t'), ['DELETE']);
});

test('flags WHERE that is always true', () => {
    assert.deepStrictEqual(kinds('DELETE FROM t WHERE 1=1'), ['DELETE']);
    assert.deepStrictEqual(kinds('UPDATE t SET a = 1 WHERE 1 = 1'), ['UPDATE']);
    assert.deepStrictEqual(kinds("DELETE FROM t WHERE 'a' = 'A'"), ['DELETE']);
    assert.deepStrictEqual(kinds('DELETE FROM t WHERE (1=1)'), ['DELETE']);
    assert.deepStrictEqual(kinds('DELETE FROM t WHERE 1<>0'), ['DELETE']);
    assert.deepStrictEqual(kinds('DELETE FROM t WHERE 1=1 AND (2>1)'), ['DELETE']);
    assert.deepStrictEqual(kinds("UPDATE t SET a = 1 WHERE Product_Id = 'A' OR 1=1"), ['UPDATE']);
    assert.deepStrictEqual(kinds("DELETE FROM t WHERE 1=1 -- AND Product_Id = 'A'"), ['DELETE']);
    assert.deepStrictEqual(kinds('DELETE FROM t WHERE 1=1 OPTION (MAXDOP 1)'), ['DELETE']);
    assert.deepStrictEqual(kinds('DELETE FROM t WHERE 1=1;\nSELECT * FROM u WHERE id = 1'), ['DELETE']);
    assert.match(analyze('DELETE FROM t WHERE 1=1')[0].message, /เป็นจริงเสมอ/);
});

test('allows WHERE 1=1 when combined with a real filter', () => {
    assert.deepStrictEqual(kinds("DELETE FROM t WHERE 1=1 AND Product_Id = 'A'"), []);
    assert.deepStrictEqual(kinds('DELETE FROM t WHERE 1=0'), []);
    assert.deepStrictEqual(kinds("DELETE FROM t WHERE 'a' = 'b'"), []);
    assert.deepStrictEqual(kinds('UPDATE t SET a = 1 WHERE (1=1 AND id = 5) OR id = 6'), []);
    assert.deepStrictEqual(kinds('DELETE FROM t WHERE x BETWEEN 1 AND 1'), []);
    assert.deepStrictEqual(kinds('DELETE FROM t WHERE CASE WHEN a = 1 OR 1 = 1 THEN 1 ELSE 0 END = 1'), []);
    assert.deepStrictEqual(kinds('DELETE FROM t WHERE id IN (SELECT id FROM u WHERE 1=1)'), []);
});

test('reports each statement separately', () => {
    const sql = "UPDATE a SET x = 1 WHERE id = 1\nUPDATE b SET x = 1\nDELETE FROM c\nDELETE FROM d WHERE 1 = 0";
    const f = analyze(sql);
    assert.deepStrictEqual(f.map(x => x.snippet), ['UPDATE b SET x = 1', 'DELETE FROM c']);
});
