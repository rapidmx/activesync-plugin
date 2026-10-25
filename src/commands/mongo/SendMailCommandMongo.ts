///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { EncryptionPolicyMongo, FolderMongo, MailboxMongo, MessageMongo, ZeroAccessIndexEntryMongo } from "@rapidmx/restapi/mongo";
import { SendMailCommand } from "../SendMailCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class SendMailCommandMongo extends SendMailCommand {
    protected folderClass: any = FolderMongo;
    protected messageClass: any = MessageMongo;
    protected mailboxClass: any = MailboxMongo;
    protected encryptionPolicyClass: any = EncryptionPolicyMongo;
    protected zeroAccessIndexEntryClass: any = ZeroAccessIndexEntryMongo;
}
