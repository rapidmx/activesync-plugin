///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { EncryptionPolicySQL, FolderSQL, MailboxSQL, MessageSQL, ZeroAccessIndexEntrySQL } from "@rapidmx/restapi/sql";
import { SmartForwardCommand } from "../SmartForwardCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class SmartForwardCommandSQL extends SmartForwardCommand {
    protected folderClass: any = FolderSQL;
    protected messageClass: any = MessageSQL;
    protected mailboxClass: any = MailboxSQL;
    protected encryptionPolicyClass: any = EncryptionPolicySQL;
    protected zeroAccessIndexEntryClass: any = ZeroAccessIndexEntrySQL;
}
