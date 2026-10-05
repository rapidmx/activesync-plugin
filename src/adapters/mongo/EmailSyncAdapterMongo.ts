///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AttachmentMongo, FolderMongo, LabelMongo } from "@rapidmx/restapi/mongo";
import { EmailSyncAdapter } from "../EmailSyncAdapter.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class EmailSyncAdapterMongo extends EmailSyncAdapter {
    protected labelClass: any = LabelMongo;
    protected folderClass: any = FolderMongo;
    protected attachmentClass: any = AttachmentMongo;
}
