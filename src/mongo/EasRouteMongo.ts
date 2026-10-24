///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailboxMongo } from "@rapidmx/restapi/mongo";
import { RouteDecorators } from "@rapidrest/service-core";
import { DeviceSyncStateMongo } from "../models/mongo/DeviceSyncStateMongo.js";
import { EasCollectionStateMongo } from "../models/mongo/EasCollectionStateMongo.js";
import { BaseEasRoute } from "../BaseEasRoute.js";
import { ProvisionCommand } from "../commands/ProvisionCommand.js";
import { PingCommandMongo } from "../commands/mongo/PingCommandMongo.js";
import { FolderSyncCommandMongo } from "../commands/mongo/FolderSyncCommandMongo.js";
import { SyncCommandMongo } from "../commands/mongo/SyncCommandMongo.js";
import { SendMailCommandMongo } from "../commands/mongo/SendMailCommandMongo.js";
import { SmartForwardCommandMongo } from "../commands/mongo/SmartForwardCommandMongo.js";
import { SmartReplyCommandMongo } from "../commands/mongo/SmartReplyCommandMongo.js";
import { ItemOperationsCommandMongo } from "../commands/mongo/ItemOperationsCommandMongo.js";
import { SearchCommandMongo } from "../commands/mongo/SearchCommandMongo.js";
import { MeetingResponseCommandMongo } from "../commands/mongo/MeetingResponseCommandMongo.js";
import { SettingsCommandMongo } from "../commands/mongo/SettingsCommandMongo.js";
import { GetItemEstimateCommandMongo } from "../commands/mongo/GetItemEstimateCommandMongo.js";
import { MoveItemsCommandMongo } from "../commands/mongo/MoveItemsCommandMongo.js";
import { ResolveRecipientsCommandMongo } from "../commands/mongo/ResolveRecipientsCommandMongo.js";
const { Route } = RouteDecorators;

/**
 * Mongo-backed concrete `BaseEasRoute`, mounted at the protocol's well-known path. Exported from this plugin's
 * `./mongo` entry point, so the server host mounts it without a wrapper class of its own.
 *
 * @author Jean-Philippe Steinmetz
 */
@Route("/Microsoft-Server-ActiveSync")
export class EasRouteMongo extends BaseEasRoute<DeviceSyncStateMongo, MailboxMongo> {
    protected deviceSyncStateClass: any = DeviceSyncStateMongo;
    protected mailboxClass: any = MailboxMongo;
    protected collectionStateClass: any = EasCollectionStateMongo;
    protected commandHandlerClasses: any[] = [
        ProvisionCommand,
        FolderSyncCommandMongo,
        SyncCommandMongo,
        SendMailCommandMongo,
        SmartForwardCommandMongo,
        SmartReplyCommandMongo,
        ItemOperationsCommandMongo,
        SearchCommandMongo,
        MeetingResponseCommandMongo,
        SettingsCommandMongo,
        PingCommandMongo,
        GetItemEstimateCommandMongo,
        MoveItemsCommandMongo,
        ResolveRecipientsCommandMongo,
    ];
}
