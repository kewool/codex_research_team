// @ts-nocheck
import { existsSync, readFileSync } from "node:fs";
import { SessionEvent } from "../../shared/types";
import {
  formatDigestEvent,
} from "./helpers";

export interface PendingDigest {
  totalCount: number;
  latestGoal: SessionEvent | null;
  operatorEvents: SessionEvent[];
  directInputs: SessionEvent[];
  channelEvents: Record<string, SessionEvent[]>;
  otherEvents: SessionEvent[];
}

export function emptyPendingDigest(): PendingDigest {
  return {
    totalCount: 0,
    latestGoal: null,
    operatorEvents: [],
    directInputs: [],
    channelEvents: {},
    otherEvents: [],
  };
}

export function hasPendingDigest(digest: PendingDigest): boolean {
  return digest.totalCount > 0;
}

export function mergePendingDigest(digest: PendingDigest, event: SessionEvent): PendingDigest {
  if (event.metadata?.goalEvent) {
    return {
      ...emptyPendingDigest(),
      totalCount: 1,
      latestGoal: event,
    };
  }

  const next: PendingDigest = {
    totalCount: digest.totalCount + 1,
    latestGoal: digest.latestGoal,
    operatorEvents: [...digest.operatorEvents],
    directInputs: [...digest.directInputs],
    channelEvents: Object.fromEntries(
      Object.entries(digest.channelEvents).map(([channel, events]) => [channel, [...events]]),
    ),
    otherEvents: [...digest.otherEvents],
  };

  if (event.metadata?.operatorEvent) {
    if (event.metadata?.directInput) {
      next.directInputs = [...next.directInputs, event];
    } else {
      next.operatorEvents = [...next.operatorEvents, event];
    }
    return next;
  }

  if (event.channel !== "status" && event.channel !== "system") {
    next.channelEvents[event.channel] = [...(next.channelEvents[event.channel] || []), event];
    return next;
  }

  next.otherEvents = [...next.otherEvents, event];
  return next;
}

function buildDigestSection(title: string, events: SessionEvent[], maxChars = 220): string {
  if (events.length === 0) {
    return "";
  }
  return `${title}:\n${events.map((event) => formatDigestEvent(event, maxChars)).join("\n")}`;
}

export function buildTriggerSummary(digest: PendingDigest): string {
  const sections: string[] = [];
  if (digest.latestGoal) {
    sections.push(`Goal update:\n${formatDigestEvent(digest.latestGoal, 420)}`);
  }
  const directInputsSection = buildDigestSection("Direct operator inputs", digest.directInputs, 480);
  if (directInputsSection) {
    sections.push(directInputsSection);
  }
  const operatorSection = buildDigestSection("Operator directives", digest.operatorEvents, 320);
  if (operatorSection) {
    sections.push(operatorSection);
  }
  for (const [channel, events] of Object.entries(digest.channelEvents)) {
    const channelSection = buildDigestSection(`Channel digest: ${channel}`, events, 220);
    if (channelSection) {
      sections.push(channelSection);
    }
  }
  const otherSection = buildDigestSection("Additional channel updates", digest.otherEvents, 180);
  if (otherSection) {
    sections.push(otherSection);
  }

  return sections.join("\n\n");
}

export function digestSequences(digest: PendingDigest): Set<number> {
  const sequences = new Set<number>();
  const push = (event: SessionEvent | null | undefined): void => {
    const sequence = Number(event?.sequence || 0);
    if (sequence > 0) {
      sequences.add(sequence);
    }
  };
  push(digest.latestGoal);
  for (const event of digest.operatorEvents) {
    push(event);
  }
  for (const event of digest.directInputs) {
    push(event);
  }
  for (const events of Object.values(digest.channelEvents)) {
    for (const event of events) {
      push(event);
    }
  }
  for (const event of digest.otherEvents) {
    push(event);
  }
  return sequences;
}

export function maxDigestSequence(digest: PendingDigest | null): number {
  if (!digest) {
    return 0;
  }
  let maxSequence = 0;
  for (const sequence of digestSequences(digest)) {
    if (sequence > maxSequence) {
      maxSequence = sequence;
    }
  }
  return maxSequence;
}

export function digestEvents(digest: PendingDigest | null): SessionEvent[] {
  if (!digest) {
    return [];
  }
  const events = [
    ...(digest.latestGoal ? [digest.latestGoal] : []),
    ...digest.operatorEvents,
    ...digest.directInputs,
    ...Object.values(digest.channelEvents).flat(),
    ...digest.otherEvents,
  ];
  return [...events].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
}

export function combinePendingDigests(...digests: Array<PendingDigest | null | undefined>): PendingDigest {
  const combined = emptyPendingDigest();
  const seen = new Set<number>();
  const events = digests.flatMap((digest) => digestEvents(digest));
  for (const event of events) {
    const sequence = Number(event.sequence || 0);
    if (sequence > 0 && seen.has(sequence)) {
      continue;
    }
    if (sequence > 0) {
      seen.add(sequence);
    }
    const next = mergePendingDigest(combined, event);
    combined.totalCount = next.totalCount;
    combined.latestGoal = next.latestGoal;
    combined.operatorEvents = next.operatorEvents;
    combined.directInputs = next.directInputs;
    combined.channelEvents = next.channelEvents;
    combined.otherEvents = next.otherEvents;
  }
  return combined;
}

export function readSessionEvents(filePath: string): SessionEvent[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = readFileSync(filePath, "utf8").replace(/^\ufeff/, "");
  if (!raw.trim()) {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as SessionEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is SessionEvent => Boolean(event && Number(event.sequence) > 0));
}
