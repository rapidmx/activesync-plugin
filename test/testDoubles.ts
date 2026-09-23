///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Lightweight, deterministic test-double implementations of this library's pluggable interfaces
// (`BlobStore`, `SearchProvider`, `SpamScanProvider`, `AvScanProvider`, `MailTransport`), registered with an
// `ObjectFactory` under the same string names the library's `@Inject("...")` decorators resolve against. Every
// integration test that boots the shared `test/server-mongo`/`test/server-sql` fixture app needs these
// registered *before* `server.start()`, because `Server` eagerly instantiates every route it discovers -
// including routes (Attachment/Message/MailIngest/Search) that inject these interfaces - regardless of which
// specific route a given test file is exercising. This is a deliberate departure from `@rapidrest/auth`'s "no
// shared test utility" convention: this library has pluggable interfaces auth does not, and duplicating this
// registration across ~24 integration test files would be unreasonable.
import {
    AvVerdict,
    SpamVerdict,
    type BlobPutOptions,
    type BlobRange,
    type BlobStore,
    type DnsMxRecord,
    type DnsResolver,
    type DnsSrvRecord,
    type MailTransport,
    type OutboundMessage,
    type TransportResult,
} from "@rapidmx/restapi";
import type {
    CandidateQuery,
    CandidateResultPage,
    SearchDocument,
    SearchEntityType,
    SearchProvider,
    SearchQuery,
    SearchResultPage,
} from "@rapidmx/restapi/search";
import type { AvScanProvider, AvScanResult, ScanEnvelope, SpamScanProvider, SpamScanResult } from "@rapidmx/restapi/scan";
import type { ObjectFactory } from "@rapidrest/service-core";

/** An in-memory `BlobStore` — content lives only for the lifetime of the process. */
export class InMemoryBlobStore implements BlobStore {
    private store: Map<string, Buffer> = new Map();

    public async put(key: string, data: Buffer | NodeJS.ReadableStream, _options?: BlobPutOptions): Promise<void> {
        if (Buffer.isBuffer(data)) {
            this.store.set(key, data);
            return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of data as any) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        this.store.set(key, Buffer.concat(chunks));
    }

    public async get(key: string): Promise<Buffer> {
        const value: Buffer | undefined = this.store.get(key);
        if (!value) {
            throw new Error(`InMemoryBlobStore: no blob at key '${key}'`);
        }
        return value;
    }

    public async getStream(key: string, range?: BlobRange): Promise<NodeJS.ReadableStream> {
        const { Readable } = await import("stream");
        const full: Buffer = await this.get(key);
        const content: Buffer = range ? full.subarray(range.start, range.end !== undefined ? range.end + 1 : undefined) : full;
        return Readable.from(content);
    }

    public async delete(key: string): Promise<void> {
        this.store.delete(key);
    }

    public async exists(key: string): Promise<boolean> {
        return this.store.has(key);
    }

    public async size(key: string): Promise<number> {
        return (await this.get(key)).length;
    }
}

/** A `SearchProvider` that records indexed documents in memory and does simple substring matching on search. */
export class NoopSearchProvider implements SearchProvider {
    public readonly name: string = "noop";
    public indexed: Map<string, SearchDocument> = new Map();

    private key(entityType: SearchEntityType, entityUid: string): string {
        return `${entityType}:${entityUid}`;
    }

    public async index(doc: SearchDocument): Promise<void> {
        this.indexed.set(this.key(doc.entityType, doc.entityUid), doc);
    }

    public async bulkIndex(docs: SearchDocument[]): Promise<string[]> {
        for (const doc of docs) {
            await this.index(doc);
        }
        return docs.map((doc) => doc.entityUid);
    }

    public async remove(entityType: SearchEntityType, entityUid: string): Promise<void> {
        this.indexed.delete(this.key(entityType, entityUid));
    }

    public async search(query: SearchQuery): Promise<SearchResultPage> {
        const results = Array.from(this.indexed.values())
            .filter((doc) => doc.mailboxUid === query.mailboxUid)
            .filter((doc) => !query.entityTypes || query.entityTypes.includes(doc.entityType))
            .filter((doc) => (doc.subject ?? "").includes(query.text) || (doc.body ?? "").includes(query.text))
            .map((doc) => ({ entityType: doc.entityType, entityUid: doc.entityUid, score: 1 }));
        return { results };
    }

    /** Never exercised by this library's own `SearchCommand` (GAL/Contact-only, doesn't use `SearchProvider`
     * at all) - implemented only so this test double satisfies the interface for whatever else in the DI graph
     * requests a `SearchProvider`. */
    public async candidates(query: CandidateQuery): Promise<CandidateResultPage> {
        const candidates = Array.from(this.indexed.values())
            .filter((doc) => doc.mailboxUid === query.mailboxUid)
            .filter((doc) => !query.entityTypes || query.entityTypes.includes(doc.entityType))
            .map((doc) => ({ entityType: doc.entityType, entityUid: doc.entityUid }));
        return { candidates };
    }
}

/**
 * A `SpamScanProvider` that reports a message as clean unless its raw content contains the marker
 * string `"X-Test-Force-Spam: true"`, in which case it reports SPAM. This lets an integration test
 * exercise `BaseMessageRoute.send()`'s spam-rejection (422) path via a real HTTP request - by including
 * that header in the message body it hands to the route - rather than needing a mocked ScanPipeline.
 */
export class AlwaysCleanSpamScanProvider implements SpamScanProvider {
    public readonly name: string = "always-clean";

    public async scoreMessage(raw: Buffer, _envelope: ScanEnvelope): Promise<SpamScanResult> {
        if (raw.includes("X-Test-Force-Spam: true")) {
            return { score: 100, verdict: SpamVerdict.SPAM, symbols: ["TEST_FORCED_SPAM"] };
        }
        return { score: 0, verdict: SpamVerdict.CLEAN, symbols: [] };
    }
}

/**
 * An `AvScanProvider` that reports content as clean unless it contains one of two marker strings:
 * `"X-Test-Force-Infected: true"` (reports INFECTED) or `"X-Test-Force-Av-Error: true"` (reports ERROR, the
 * providers' own documented fail-closed outcome for a scan-engine outage). Lets a test exercise a real
 * `ScanPipeline`'s/`ScanQueueJob`'s quarantine path via genuine content - by including the marker in the raw
 * message or an attachment's bytes - rather than needing a mocked AvScanProvider.
 */
export class AlwaysCleanAvScanProvider implements AvScanProvider {
    public readonly name: string = "always-clean";

    public async scanBuffer(content: Buffer, _filename?: string): Promise<AvScanResult> {
        if (content.includes("X-Test-Force-Infected: true")) {
            return { verdict: AvVerdict.INFECTED, signatureName: "Test-Signature" };
        }
        if (content.includes("X-Test-Force-Av-Error: true")) {
            return { verdict: AvVerdict.ERROR };
        }
        return { verdict: AvVerdict.CLEAN };
    }
}

/**
 * A `MailTransport` that records every message it was asked to send, without relaying anywhere. Rejects
 * (accepts none of) any envelope recipient whose address is exactly `reject@example.com`, so an
 * integration test can exercise `BaseMessageRoute.send()`'s transport-rejection (502) path via a real
 * HTTP request - by addressing the message to that recipient - rather than needing a mocked
 * MailTransport.
 */
export class RecordingMailTransport implements MailTransport {
    public readonly name: string = "recording";
    public sent: OutboundMessage[] = [];

    public async send(message: OutboundMessage): Promise<TransportResult> {
        if (message.envelopeTo.includes("reject@example.com")) {
            return { accepted: [], rejected: message.envelopeTo };
        }
        this.sent.push(message);
        return { accepted: message.envelopeTo, rejected: [] };
    }
}

/**
 * A `DnsResolver` that finds nothing for every lookup. This library's EAS surface never itself exercises
 * federation/domain-verification behavior, but `@rapidmx/restapi`'s `BaseMessageRoute`/`ScanQueueJob` now
 * unconditionally `@Inject("DnsResolver")` (federated-peer detection for receipt/encryption-key scoping), and
 * `Server.start()` eagerly instantiates every route it discovers - so this needs to be registered for the
 * shared test fixture apps to boot at all, even though no EAS test ever triggers a real lookup through it.
 */
export class StaticDnsResolver implements DnsResolver {
    public async resolveTxt(hostname: string): Promise<string[][]> {
        throw new Error(`StaticDnsResolver: no TXT records for ${hostname}`);
    }

    public async resolveMx(hostname: string): Promise<DnsMxRecord[]> {
        throw new Error(`StaticDnsResolver: no MX records for ${hostname}`);
    }

    public async resolveCname(hostname: string): Promise<string[]> {
        throw new Error(`StaticDnsResolver: no CNAME records for ${hostname}`);
    }

    public async resolveSrv(hostname: string): Promise<DnsSrvRecord[]> {
        throw new Error(`StaticDnsResolver: no SRV records for ${hostname}`);
    }
}

/**
 * Registers a full set of test-double implementations for this library's pluggable interfaces against
 * `objectFactory`. Call this before `server.start()` in any integration test that boots the shared server
 * fixture apps.
 */
export function registerTestDoubles(objectFactory: ObjectFactory): void {
    objectFactory.register(InMemoryBlobStore, "BlobStore");
    objectFactory.register(NoopSearchProvider, "SearchProvider");
    objectFactory.register(AlwaysCleanSpamScanProvider, "SpamScanProvider");
    objectFactory.register(AlwaysCleanAvScanProvider, "AvScanProvider");
    objectFactory.register(RecordingMailTransport, "MailTransport");
    objectFactory.register(StaticDnsResolver, "DnsResolver");
}
