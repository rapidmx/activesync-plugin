///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailboxSQL } from "@rapidmx/restapi/sql";
import { RouteDecorators } from "@rapidrest/service-core";
import { DeviceSyncStateSQL } from "../models/sql/DeviceSyncStateSQL.js";
import { EasCollectionStateSQL } from "../models/sql/EasCollectionStateSQL.js";
import { BaseEasRoute } from "../BaseEasRoute.js";
import { ProvisionCommand } from "../commands/ProvisionCommand.js";
import { PingCommandSQL } from "../commands/sql/PingCommandSQL.js";
import { FolderSyncCommandSQL } from "../commands/sql/FolderSyncCommandSQL.js";
import { SyncCommandSQL } from "../commands/sql/SyncCommandSQL.js";
import { SendMailCommandSQL } from "../commands/sql/SendMailCommandSQL.js";
import { SmartForwardCommandSQL } from "../commands/sql/SmartForwardCommandSQL.js";
import { SmartReplyCommandSQL } from "../commands/sql/SmartReplyCommandSQL.js";
import { ItemOperationsCommandSQL } from "../commands/sql/ItemOperationsCommandSQL.js";
import { SearchCommandSQL } from "../commands/sql/SearchCommandSQL.js";
import { MeetingResponseCommandSQL } from "../commands/sql/MeetingResponseCommandSQL.js";
import { SettingsCommandSQL } from "../commands/sql/SettingsCommandSQL.js";
import { GetItemEstimateCommandSQL } from "../commands/sql/GetItemEstimateCommandSQL.js";
import { MoveItemsCommandSQL } from "../commands/sql/MoveItemsCommandSQL.js";
import { ResolveRecipientsCommandSQL } from "../commands/sql/ResolveRecipientsCommandSQL.js";
const { Route } = RouteDecorators;

/**
 * SQL-backed concrete `BaseEasRoute`, mounted at the protocol's well-known path. Exported from this plugin's
 * `./sql` entry point.
 *
 * @author Jean-Philippe Steinmetz
 */
@Route("/Microsoft-Server-ActiveSync")
export class EasRouteSQL extends BaseEasRoute<DeviceSyncStateSQL, MailboxSQL> {
    protected deviceSyncStateClass: any = DeviceSyncStateSQL;
    protected mailboxClass: any = MailboxSQL;
    protected collectionStateClass: any = EasCollectionStateSQL;
    protected commandHandlerClasses: any[] = [
        ProvisionCommand,
        FolderSyncCommandSQL,
        SyncCommandSQL,
        SendMailCommandSQL,
        SmartForwardCommandSQL,
        SmartReplyCommandSQL,
        ItemOperationsCommandSQL,
        SearchCommandSQL,
        MeetingResponseCommandSQL,
        SettingsCommandSQL,
        PingCommandSQL,
        GetItemEstimateCommandSQL,
        MoveItemsCommandSQL,
        ResolveRecipientsCommandSQL,
    ];
}
