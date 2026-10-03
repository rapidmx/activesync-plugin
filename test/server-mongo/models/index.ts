// Re-exports just the library's MongoDB model classes EAS needs so the test Server's ClassLoader (rooted at
// `test/server-mongo`) can discover their `@DataStore` metadata alongside the test routes that use them.
// Deliberately a NAMED (not wildcard) re-export: `@rapidmx/restapi/mongo` bundles routes/jobs alongside its
// models (unlike the old monolith's models-only `src/models/mongo/index.js` this replaced), and a wildcard
// re-export here would make the ClassLoader also discover and eagerly initialize every REST route/job class
// restapi defines - none of which this EAS-only test harness configures dependencies for.
export {
    AttachmentMongo,
    AuditLogEntryMongo,
    CalendarEventMongo,
    ContactMongo,
    FolderMongo,
    LabelMongo,
    MailboxMongo,
    MatterMongo,
    MessageMongo,
    TaskMongo,
} from "@rapidmx/restapi/mongo";
// This plugin's own model.
export { DeviceSyncStateMongo } from "../../../src/models/mongo/DeviceSyncStateMongo.js";
export { EasCollectionStateMongo } from "../../../src/models/mongo/EasCollectionStateMongo.js";
export { EasCollectionChunkMongo } from "../../../src/models/mongo/EasCollectionChunkMongo.js";
