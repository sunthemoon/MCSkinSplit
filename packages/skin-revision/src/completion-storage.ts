import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { sha256 } from "./hash";

export const COMPLETION_PROPOSAL_FILE_NAMES = [
  "proposal.json",
  "allowed-mask.png",
] as const;

export const COMPLETION_CANDIDATE_FILE_NAMES = [
  "candidate.json",
  "texture.png",
  "write-mask.png",
  "generated-mask.png",
] as const;

export type CompletionProposalFileName =
  (typeof COMPLETION_PROPOSAL_FILE_NAMES)[number];
export type CompletionCandidateFileName =
  (typeof COMPLETION_CANDIDATE_FILE_NAMES)[number];

export interface CompletionCandidateStorageInput {
  readonly candidateId: string;
  readonly files: Readonly<Record<CompletionCandidateFileName, Uint8Array>>;
}

export interface CompletionProposalStorageInput {
  readonly proposalId: string;
  readonly files: Readonly<Record<CompletionProposalFileName, Uint8Array>>;
  readonly candidates: readonly CompletionCandidateStorageInput[];
}

export interface StoredCompletionFile<Name extends string = string> {
  readonly name: Name;
  readonly storagePath: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface VerifiedCompletionCandidateStorage {
  readonly candidateId: string;
  readonly directory: string;
  readonly files: Readonly<
    Record<CompletionCandidateFileName, StoredCompletionFile<CompletionCandidateFileName>>
  >;
}

export interface CompletionCandidateWriteResult {
  readonly storage: VerifiedCompletionCandidateStorage;
  readonly created: boolean;
}

export interface VerifiedCompletionProposalStorage {
  readonly directory: string;
  readonly files: Readonly<
    Record<CompletionProposalFileName, StoredCompletionFile<CompletionProposalFileName>>
  >;
  readonly candidates: Readonly<Record<string, VerifiedCompletionCandidateStorage>>;
}

export class CompletionStorage {
  readonly dataDirectory: string;

  constructor(dataDirectory: string) {
    this.dataDirectory = resolve(dataDirectory);
  }

  proposalDirectory(proposalId: string): string {
    assertSafeId("completion proposal", proposalId);
    return resolveWithin(this.dataDirectory, "completions", proposalId);
  }

  candidateDirectory(proposalId: string, candidateId: string): string {
    assertSafeId("completion proposal", proposalId);
    assertSafeId("completion candidate", candidateId);
    return resolveWithin(
      this.proposalDirectory(proposalId),
      "candidates",
      candidateId,
    );
  }

  async writeProposal(
    input: CompletionProposalStorageInput,
  ): Promise<VerifiedCompletionProposalStorage> {
    assertUniqueCandidateIds(input.candidates);
    const completionsDirectory = resolveWithin(this.dataDirectory, "completions");
    await mkdir(completionsDirectory, { recursive: true });
    const finalDirectory = this.proposalDirectory(input.proposalId);
    const temporaryDirectory = resolveWithin(
      completionsDirectory,
      `.${input.proposalId}.${randomUUID()}.tmp`,
    );
    await mkdir(temporaryDirectory, { recursive: false });
    let finalized = false;

    try {
      for (const fileName of COMPLETION_PROPOSAL_FILE_NAMES) {
        await writeDurableFile(
          resolveWithin(temporaryDirectory, fileName),
          input.files[fileName],
        );
      }
      const candidatesDirectory = resolveWithin(temporaryDirectory, "candidates");
      await mkdir(candidatesDirectory, { recursive: false });
      for (const candidate of input.candidates) {
        assertSafeId("completion candidate", candidate.candidateId);
        const directory = resolveWithin(candidatesDirectory, candidate.candidateId);
        await mkdir(directory, { recursive: false });
        for (const fileName of COMPLETION_CANDIDATE_FILE_NAMES) {
          await writeDurableFile(
            resolveWithin(directory, fileName),
            candidate.files[fileName],
          );
        }
      }
      await rename(temporaryDirectory, finalDirectory);
      finalized = true;
      return await this.readProposal(
        input.proposalId,
        input.candidates.map((candidate) => candidate.candidateId),
      );
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      if (finalized) {
        await rm(finalDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async readProposal(
    proposalId: string,
    candidateIds: readonly string[],
  ): Promise<VerifiedCompletionProposalStorage> {
    assertUniqueIds("completion candidate", candidateIds);
    const directory = this.proposalDirectory(proposalId);
    const files = {} as Record<
      CompletionProposalFileName,
      StoredCompletionFile<CompletionProposalFileName>
    >;
    for (const fileName of COMPLETION_PROPOSAL_FILE_NAMES) {
      files[fileName] = await this.readFile(
        resolveWithin(directory, fileName),
        `completions/${proposalId}/${fileName}`,
        fileName,
      );
    }
    const candidates: Record<string, VerifiedCompletionCandidateStorage> = {};
    for (const candidateId of candidateIds) {
      candidates[candidateId] = await this.readCandidate(proposalId, candidateId);
    }
    return { directory, files, candidates };
  }

  async readCandidate(
    proposalId: string,
    candidateId: string,
  ): Promise<VerifiedCompletionCandidateStorage> {
    const directory = this.candidateDirectory(proposalId, candidateId);
    const files = {} as Record<
      CompletionCandidateFileName,
      StoredCompletionFile<CompletionCandidateFileName>
    >;
    for (const fileName of COMPLETION_CANDIDATE_FILE_NAMES) {
      files[fileName] = await this.readFile(
        resolveWithin(directory, fileName),
        `completions/${proposalId}/candidates/${candidateId}/${fileName}`,
        fileName,
      );
    }
    return { candidateId, directory, files };
  }

  async writeCandidate(
    proposalId: string,
    input: CompletionCandidateStorageInput,
  ): Promise<CompletionCandidateWriteResult> {
    assertSafeId("completion proposal", proposalId);
    assertSafeId("completion candidate", input.candidateId);
    const candidatesDirectory = resolveWithin(
      this.proposalDirectory(proposalId),
      "candidates",
    );
    await mkdir(candidatesDirectory, { recursive: true });
    const finalDirectory = this.candidateDirectory(
      proposalId,
      input.candidateId,
    );
    const temporaryDirectory = resolveWithin(
      candidatesDirectory,
      `.${input.candidateId}.${randomUUID()}.tmp`,
    );
    await mkdir(temporaryDirectory, { recursive: false });
    try {
      for (const fileName of COMPLETION_CANDIDATE_FILE_NAMES) {
        await writeDurableFile(
          resolveWithin(temporaryDirectory, fileName),
          input.files[fileName],
        );
      }
      await rename(temporaryDirectory, finalDirectory);
      return {
        storage: await this.readCandidate(proposalId, input.candidateId),
        created: true,
      };
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      try {
        const storage = await this.readCandidate(proposalId, input.candidateId);
        if (COMPLETION_CANDIDATE_FILE_NAMES.every(
          (fileName) => storage.files[fileName].sha256 === sha256(input.files[fileName]),
        )) {
          return { storage, created: false };
        }
      } catch {
        // Preserve the original atomic-write error when no exact replay exists.
      }
      throw error;
    }
  }

  async removeNewProposal(proposalId: string): Promise<void> {
    await rm(this.proposalDirectory(proposalId), { recursive: true, force: true });
  }

  async removeNewCandidate(proposalId: string, candidateId: string): Promise<void> {
    await rm(this.candidateDirectory(proposalId, candidateId), {
      recursive: true,
      force: true,
    });
  }

  private async readFile<Name extends string>(
    path: string,
    storagePath: string,
    name: Name,
  ): Promise<StoredCompletionFile<Name>> {
    const bytes = new Uint8Array(await readFile(path));
    return { name, storagePath, bytes, sha256: sha256(bytes) };
  }
}

async function writeDurableFile(path: string, data: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertUniqueCandidateIds(
  candidates: readonly CompletionCandidateStorageInput[],
): void {
  assertUniqueIds(
    "completion candidate",
    candidates.map((candidate) => candidate.candidateId),
  );
}

function assertUniqueIds(kind: string, ids: readonly string[]): void {
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw new TypeError(`Duplicate ${kind} id`);
  }
  for (const id of ids) assertSafeId(kind, id);
}

function assertSafeId(kind: string, value: string): void {
  if (!/^[a-z][a-z0-9_-]{2,100}$/u.test(value)) {
    throw new TypeError(`Unsafe ${kind} id: ${value}`);
  }
}

function resolveWithin(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, ...segments);
  const relation = relative(resolvedRoot, candidate);
  if (
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new TypeError(`Resolved path escapes storage root: ${candidate}`);
  }
  return candidate;
}
