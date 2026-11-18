const uncompressedUtf8 = `(NEW.encoding='utf8' OR (
  substr(NEW.encoding,1,7)='repair:' AND instr(substr(NEW.encoding,8),':')>0
  AND substr(NEW.encoding,8+instr(substr(NEW.encoding,8),':'))='utf8'))`;

export const contentLifecycleColdAliasesSchemaSql = `
DROP TRIGGER content_cold_insert;
DROP TRIGGER content_cold_update;
CREATE TRIGGER content_cold_insert AFTER INSERT ON contents
WHEN NEW.mime_type='application/json' AND ${uncompressedUtf8} AND NEW.byte_length BETWEEN 256 AND 65536
  AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT OR REPLACE INTO content_lifecycle_cold_pending VALUES(NEW.id,NEW.sha256);
END;
CREATE TRIGGER content_cold_update AFTER UPDATE OF data,encoding ON contents
WHEN NEW.mime_type='application/json' AND ${uncompressedUtf8} AND NEW.byte_length BETWEEN 256 AND 65536
  AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT OR REPLACE INTO content_lifecycle_cold_pending VALUES(NEW.id,NEW.sha256);
END;
-- Revisit pre-upgrade aliases through the established bounded background cursor.
UPDATE content_lifecycle_progress SET content_cursor=0,revision=revision+1 WHERE id=1;
`;
