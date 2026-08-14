export interface PendingCatalogAiHydration {
  readonly activationRequestId: number;
  readonly aiDetailRequestId: number;
  readonly revisionId: string;
}

export function shouldDeferGenericAiHydration(
  selectedRevisionId: string,
  pending: PendingCatalogAiHydration | null,
): boolean {
  return pending?.revisionId === selectedRevisionId;
}
