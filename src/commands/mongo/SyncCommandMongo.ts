///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MessageMongo, ContactMongo, CalendarEventMongo, TaskMongo, MailboxMongo, FolderMongo, AuditLogEntryMongo, EncryptionPolicyMongo, ZeroAccessIndexEntryMongo } from "@rapidmx/restapi/mongo";
import { EasCollectionStateMongo } from "../../models/mongo/EasCollectionStateMongo.js";
import { EasCollectionChunkMongo } from "../../models/mongo/EasCollectionChunkMongo.js";
import { EmailSyncAdapterMongo } from "../../adapters/mongo/EmailSyncAdapterMongo.js";
import { ContactsSyncAdapter } from "../../adapters/ContactsSyncAdapter.js";
import { CalendarSyncAdapter } from "../../adapters/CalendarSyncAdapter.js";
import { TasksSyncAdapter } from "../../adapters/TasksSyncAdapter.js";
import { SyncCommand, type SyncCollectionBinding } from "../SyncCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class SyncCommandMongo extends SyncCommand {
    protected mailboxClass: any = MailboxMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
    protected encryptionPolicyClass: any = EncryptionPolicyMongo;
    protected zeroAccessIndexEntryClass: any = ZeroAccessIndexEntryMongo;
    protected folderClass: any = FolderMongo;
    protected collectionStateClass: any = EasCollectionStateMongo;
    protected collectionChunkClass: any = EasCollectionChunkMongo;
    protected collectionBindings: Record<string, SyncCollectionBinding<any>> = {
        Email: { entityClass: MessageMongo, adapterClass: EmailSyncAdapterMongo },
        Contacts: { entityClass: ContactMongo, adapterClass: ContactsSyncAdapter },
        Calendar: { entityClass: CalendarEventMongo, adapterClass: CalendarSyncAdapter },
        Tasks: { entityClass: TaskMongo, adapterClass: TasksSyncAdapter },
    };
}
