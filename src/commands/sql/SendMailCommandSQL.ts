///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { EncryptionPolicySQL, FolderSQL, MailboxSQL, MessageSQL, ZeroAccessIndexEntrySQL } from "@rapidmx/restapi/sql";
import { SendMailCommand } from "../SendMailCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class SendMailCommandSQL extends SendMailCommand {
    protected folderClass: any = FolderSQL;
    protected messageClass: any = MessageSQL;
    protected mailboxClass: any = MailboxSQL;
    protected encryptionPolicyClass: any = EncryptionPolicySQL;
    protected zeroAccessIndexEntryClass: any = ZeroAccessIndexEntrySQL;
}
