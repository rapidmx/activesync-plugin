///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MessageSQL, ContactSQL, CalendarEventSQL, TaskSQL, MailboxSQL, FolderSQL, AuditLogEntrySQL, EncryptionPolicySQL } from "@rapidmx/restapi/sql";
import { EasCollectionStateSQL } from "../../models/sql/EasCollectionStateSQL.js";
import { EasCollectionChunkSQL } from "../../models/sql/EasCollectionChunkSQL.js";
import { EmailSyncAdapterSQL } from "../../adapters/sql/EmailSyncAdapterSQL.js";
import { ContactsSyncAdapter } from "../../adapters/ContactsSyncAdapter.js";
import { CalendarSyncAdapter } from "../../adapters/CalendarSyncAdapter.js";
import { TasksSyncAdapter } from "../../adapters/TasksSyncAdapter.js";
import { SyncCommand, type SyncCollectionBinding } from "../SyncCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class SyncCommandSQL extends SyncCommand {
    protected mailboxClass: any = MailboxSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
    protected encryptionPolicyClass: any = EncryptionPolicySQL;
    protected folderClass: any = FolderSQL;
    protected collectionStateClass: any = EasCollectionStateSQL;
    protected collectionChunkClass: any = EasCollectionChunkSQL;
    protected collectionBindings: Record<string, SyncCollectionBinding<any>> = {
        Email: { entityClass: MessageSQL, adapterClass: EmailSyncAdapterSQL },
        Contacts: { entityClass: ContactSQL, adapterClass: ContactsSyncAdapter },
        Calendar: { entityClass: CalendarEventSQL, adapterClass: CalendarSyncAdapter },
        Tasks: { entityClass: TaskSQL, adapterClass: TasksSyncAdapter },
    };
}
