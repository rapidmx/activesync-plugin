// Re-exports just the library's SQL model classes EAS needs so the test Server's ClassLoader (rooted at
// `test/server-sql`) can discover their `@DataStore` metadata alongside the test routes that use them.
// Deliberately a NAMED (not wildcard) re-export - see the identical rationale in
// test/server-mongo/models/index.ts.
export {
    AttachmentSQL,
    AuditLogEntrySQL,
    CalendarEventSQL,
    ContactSQL,
    FolderSQL,
    LabelSQL,
    MailboxSQL,
    MatterSQL,
    MessageSQL,
    TaskSQL,
} from "@rapidmx/restapi/sql";
// This plugin's own model.
export { DeviceSyncStateSQL } from "../../../src/models/sql/DeviceSyncStateSQL.js";
export { EasCollectionStateSQL } from "../../../src/models/sql/EasCollectionStateSQL.js";
export { EasCollectionChunkSQL } from "../../../src/models/sql/EasCollectionChunkSQL.js";
