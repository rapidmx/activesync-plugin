///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for the single `@Init` hook of every command, adapter, route and job, which builds each model
// repository and service once through the ObjectFactory instead of lazily inside the handlers.
import { RepoUtils } from "@rapidrest/service-core";
import { AuditLogUtils, RecoverableRepoUtils } from "@rapidmx/restapi";
import { EasRouteMongo } from "../src/mongo/EasRouteMongo.js";
import { DeviceSyncStateRouteMongo } from "../src/mongo/DeviceSyncStateRouteMongo.js";
import { EmailSyncAdapterMongo } from "../src/adapters/mongo/EmailSyncAdapterMongo.js";
import { ProvisionCommand } from "../src/commands/ProvisionCommand.js";
import { EasDeviceStateCleanupJobMongo } from "../src/jobs/mongo/EasDeviceStateCleanupJobMongo.js";
import { GetItemEstimateCommandMongo } from "../src/commands/mongo/GetItemEstimateCommandMongo.js";
import { MoveItemsCommandMongo } from "../src/commands/mongo/MoveItemsCommandMongo.js";
import { ResolveRecipientsCommandMongo } from "../src/commands/mongo/ResolveRecipientsCommandMongo.js";
import {
    FolderSyncCommandMongo,
    ItemOperationsCommandMongo,
    MeetingResponseCommandMongo,
    PingCommandMongo,
    SearchCommandMongo,
    SendMailCommandMongo,
    SettingsCommandMongo,
    SyncCommandMongo,
} from "../src/commands/mongo/index.js";

/** An ObjectFactory stand-in that records each `newInstance()` call and returns a marker for it. */
function fakeFactory(): any {
    return {
        newInstance: vi.fn(async (type: any, options?: any) => ({ type, options, command: type.name })),
    };
}

interface Case {
    name: string;
    make: () => any;
    hook: string;
    /** [repo field, class field, repo type] */
    repos: [string, string, any][];
    /** Whether the class also builds the `AuditLogUtils` service on top of its audit log repository. */
    audit?: boolean;
}

const cases: Case[] = [
    {
        name: "EmailSyncAdapter",
        make: () => new EmailSyncAdapterMongo(),
        hook: "initialize",
        repos: [
            ["labelRepo", "labelClass", RepoUtils],
            ["folderRepo", "folderClass", RepoUtils],
        ],
    },
    {
        name: "BaseDeviceSyncStateRoute",
        make: () => new DeviceSyncStateRouteMongo(),
        hook: "initialize",
        repos: [["deviceSyncStateRepo", "deviceSyncStateClass", RepoUtils]],
    },
    {
        name: "BaseEasRoute",
        make: () => new EasRouteMongo(),
        hook: "initialize",
        repos: [
            ["deviceSyncStateRepo", "deviceSyncStateClass", RepoUtils],
            ["mailboxRepo", "mailboxClass", RepoUtils],
        ],
    },
    {
        name: "ComposeMailCommand",
        make: () => new SendMailCommandMongo(),
        hook: "initialize",
        repos: [
            ["folderRepo", "folderClass", RecoverableRepoUtils],
            ["messageRepo", "messageClass", RecoverableRepoUtils],
            ["mailboxRepo", "mailboxClass", RepoUtils],
        ],
    },
    { name: "FolderSyncCommand", make: () => new FolderSyncCommandMongo(), hook: "initialize", repos: [["folderRepo", "folderClass", RepoUtils]] },
    {
        name: "GetItemEstimateCommand",
        make: () => new GetItemEstimateCommandMongo(),
        hook: "initialize",
        repos: [
            ["folderRepo", "folderClass", RepoUtils],
            ["collectionStateRepo", "collectionStateClass", RepoUtils],
            ["collectionChunkRepo", "collectionChunkClass", RepoUtils],
        ],
    },
    {
        name: "ItemOperationsCommand",
        make: () => new ItemOperationsCommandMongo(),
        hook: "initialize",
        repos: [
            ["folderRepo", "folderClass", RepoUtils],
            ["messageRepo", "messageClass", RecoverableRepoUtils],
            ["attachmentRepo", "attachmentClass", RepoUtils],
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ["auditLogRepo", "auditLogClass", RepoUtils],
        ],
        audit: true,
    },
    {
        name: "MeetingResponseCommand",
        make: () => new MeetingResponseCommandMongo(),
        hook: "initialize",
        repos: [
            ["calendarEventRepo", "calendarEventClass", RecoverableRepoUtils],
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ["messageRepo", "messageClass", RepoUtils],
        ],
    },
    {
        name: "MoveItemsCommand",
        make: () => new MoveItemsCommandMongo(),
        hook: "initialize",
        repos: [
            ["messageRepo", "messageClass", RepoUtils],
            ["folderRepo", "folderClass", RepoUtils],
        ],
    },
    { name: "PingCommand", make: () => new PingCommandMongo(), hook: "initialize", repos: [["collectionStateRepo", "collectionStateClass", RepoUtils]] },
    {
        name: "ResolveRecipientsCommand",
        make: () => new ResolveRecipientsCommandMongo(),
        hook: "initialize",
        repos: [["contactRepo", "contactClass", RepoUtils]],
    },
    {
        name: "SearchCommand",
        make: () => new SearchCommandMongo(),
        hook: "initialize",
        repos: [
            ["contactRepo", "contactClass", RepoUtils],
            ["messageRepo", "messageClass", RepoUtils],
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ["auditLogRepo", "auditLogClass", RepoUtils],
        ],
        audit: true,
    },
    { name: "SettingsCommand", make: () => new SettingsCommandMongo(), hook: "initialize", repos: [["mailboxRepo", "mailboxClass", RepoUtils]] },
    {
        name: "SyncCommand",
        make: () => new SyncCommandMongo(),
        hook: "initialize",
        repos: [
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ["folderRepo", "folderClass", RecoverableRepoUtils],
            ["collectionStateRepo", "collectionStateClass", RepoUtils],
            ["collectionChunkRepo", "collectionChunkClass", RepoUtils],
            ["auditLogRepo", "auditLogClass", RepoUtils],
        ],
        audit: true,
    },
    {
        name: "EasDeviceStateCleanupJob",
        make: () => new EasDeviceStateCleanupJobMongo(),
        hook: "init",
        repos: [
            ["deviceSyncStateRepo", "deviceSyncStateClass", RepoUtils],
            ["collectionStateRepo", "collectionStateClass", RepoUtils],
            ["collectionChunkRepo", "collectionChunkClass", RepoUtils],
        ],
    },
];

describe("@Init hooks", () => {
    for (const c of cases) {
        describe(c.name, () => {
            it("throws when the objectFactory is not set.", async () => {
                const obj: any = c.make();
                await expect(obj[c.hook]()).rejects.toThrow("objectFactory is not set.");
            });

            it("builds each repository with exactly its name and class.", async () => {
                const obj: any = c.make();
                obj._objectFactory = fakeFactory();

                await obj[c.hook]();

                for (const [field, classField, type] of c.repos) {
                    expect(obj[field].type).toBe(type);
                    expect(obj[field].options).toEqual({ name: obj[classField].name, args: [obj[classField]] });
                }
                if (c.audit) {
                    expect(obj.auditLogUtils.type).toBe(AuditLogUtils);
                    expect(obj.auditLogUtils.options).toEqual({ name: obj.auditLogClass.name, args: [obj.auditLogRepo] });
                }
            });

            it("does not rebuild a repository or service that is already set.", async () => {
                const obj: any = c.make();
                const factory = fakeFactory();
                obj._objectFactory = factory;
                const preset = c.repos.map(([field]) => [field, { preset: field }] as const);
                for (const [field, value] of preset) {
                    obj[field] = value;
                }
                const presetUtils = { preset: "auditLogUtils" };
                if (c.audit) {
                    obj.auditLogUtils = presetUtils;
                }
                // Anything other than a model repository (adapters, handlers, binding repositories) is out of scope here.
                obj.collectionBindings = {};
                if ("commandHandlerClasses" in obj) {
                    obj.commandHandlerClasses = [];
                }
                if ("emailAdapterClass" in obj) {
                    obj.emailAdapter = {};
                }

                await obj[c.hook]();

                for (const [field, value] of preset) {
                    expect(obj[field]).toBe(value);
                }
                if (c.audit) {
                    expect(obj.auditLogUtils).toBe(presetUtils);
                }
                expect(factory.newInstance).not.toHaveBeenCalled();
            });

            it("skips each repository whose model class is unset.", async () => {
                const obj: any = c.make();
                const factory = fakeFactory();
                obj._objectFactory = factory;
                for (const [, classField] of c.repos) {
                    obj[classField] = undefined;
                }
                obj.collectionBindings = {};
                if ("commandHandlerClasses" in obj) {
                    obj.commandHandlerClasses = [];
                }
                if ("emailAdapterClass" in obj) {
                    obj.emailAdapterClass = undefined;
                }

                await obj[c.hook]();

                expect(factory.newInstance).not.toHaveBeenCalled();
                for (const [field] of c.repos) {
                    expect(obj[field]).toBeUndefined();
                }
            });
        });
    }

    describe("collection bindings", () => {
        const makers: [string, () => any][] = [
            ["GetItemEstimateCommand", () => new GetItemEstimateCommandMongo()],
            ["PingCommand", () => new PingCommandMongo()],
            ["SyncCommand", () => new SyncCommandMongo()],
        ];
        for (const [name, make] of makers) {
            it(`${name} builds one recoverable repository per binding, named after its entity, once.`, async () => {
                const obj: any = make();
                const factory = fakeFactory();
                obj._objectFactory = factory;

                await obj.initialize();

                for (const [collectionClass, binding] of Object.entries<any>(obj.collectionBindings)) {
                    const repo = obj.repos.get(collectionClass);
                    expect(repo.type).toBe(RecoverableRepoUtils);
                    expect(repo.options).toEqual({ name: binding.entityClass.name, args: [binding.entityClass] });
                }
                expect(obj.repos.size).toBe(Object.keys(obj.collectionBindings).length);

                const calls = factory.newInstance.mock.calls.length;
                await obj.initialize();
                expect(factory.newInstance.mock.calls.length).toBe(calls);
            });
        }

        it("PingCommand skips the pending-change check entirely when no collection state class is bound.", async () => {
            const obj: any = new PingCommandMongo();
            const factory = fakeFactory();
            obj._objectFactory = factory;
            obj.collectionStateClass = undefined;

            await obj.initialize();

            expect(factory.newInstance).not.toHaveBeenCalled();
            expect(obj.repos.size).toBe(0);
        });

        it("SyncCommand builds each binding's adapter once, without rebuilding one that is set.", async () => {
            const obj: any = new SyncCommandMongo();
            obj._objectFactory = fakeFactory();
            const preset = { preset: true };
            obj.adapters.set("Email", preset);

            await obj.initialize();

            expect(obj.adapters.get("Email")).toBe(preset);
            for (const collectionClass of ["Contacts", "Calendar", "Tasks"]) {
                expect(obj.adapters.get(collectionClass).type).toBe(obj.collectionBindings[collectionClass].adapterClass);
            }
        });
    });

    describe("SearchCommand", () => {
        it("builds its email adapter once, and not when one is already set.", async () => {
            const obj: any = new SearchCommandMongo();
            obj._objectFactory = fakeFactory();

            await obj.initialize();
            expect(obj.emailAdapter.type).toBe(obj.emailAdapterClass);

            const preset = { preset: true };
            obj.emailAdapter = preset;
            await obj.initialize();
            expect(obj.emailAdapter).toBe(preset);
        });
    });

    describe("BaseEasRoute", () => {
        it("builds each command handler through the factory and registers it under its command.", async () => {
            const obj: any = new EasRouteMongo();
            const factory = fakeFactory();
            obj._objectFactory = factory;

            await obj.initialize();

            expect(factory.newInstance).toHaveBeenCalledWith(ProvisionCommand);
            expect(obj.handlers.size).toBe(obj.commandHandlerClasses.length);
            expect(obj.handlers.get("ProvisionCommand")).toBeDefined();
        });
    });
});
