import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useOptionalAuth } from '../auth/context/AuthContext';

import {
  createInternalRoom, getInternalMessages, getInternalRoom, markInternalRead, revalidateInternalRoom, sendInternalMessage,
  type InternalMember, type InternalMessage, type InternalRoom,
} from './internalSessionChatApi';
import { clearInternalSessionChatState, setInternalMentionCount } from './internalSessionChatStore';
import { useInternalSessionChatRealtime, type InternalChatFrame } from './useInternalSessionChatRealtime';

const bySequence = (list: InternalMessage[]) => [...list].sort((a, b) => a.sequence - b.sequence);
const upsert = (list: InternalMessage[], message: InternalMessage) =>
  bySequence([...list.filter((item) => item.id !== message.id), message]);

/**
 * One session's request scope: its id and a signal aborted when the session
 * changes. B-1666: every await re-checks it, so a late answer for room A never
 * lands in room B.
 */
type RoomScope = { id: string; signal: AbortSignal };
const isLive = (scope: RoomScope, current: { current: string | null | undefined }) =>
  !scope.signal.aborted && current.current === scope.id;

/** Room state, REST snapshot and realtime frames for one session. */
function useInternalRoom(sessionId: string | null | undefined, enabled: boolean) {
  const [room, setRoom] = useState<InternalRoom | null>(null);
  const [messages, setMessages] = useState<InternalMessage[]>([]);
  const sessionRef = useRef(sessionId);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    sessionRef.current = sessionId;
    const controller = new AbortController();
    controllerRef.current = controller;
    setRoom(null); setMessages([]);
    if (enabled && sessionId) {
      // The timeline shows team messages inline, so a member's history loads
      // with the room instead of waiting for the realtime snapshot.
      void getInternalRoom(sessionId, controller.signal).then(async (next) => {
        if (!next || controller.signal.aborted) return;
        setRoom(next); setInternalMentionCount(sessionId, next.unreadMentionCount);
        const page = await getInternalMessages(sessionId, controller.signal).catch(() => []);
        if (!controller.signal.aborted) setMessages(bySequence(page));
      }).catch(() => undefined);
    }
    return () => controller.abort();
  }, [enabled, sessionId]);
  /** The live scope for a request starting now, or null without a session. */
  const scope = useCallback((): RoomScope | null => {
    const id = sessionRef.current;
    const controller = controllerRef.current;
    return id && controller && !controller.signal.aborted ? { id, signal: controller.signal } : null;
  }, []);
  const live = useCallback((current: RoomScope) => isLive(current, sessionRef), []);
  const snapshot = useCallback(async () => {
    const current = scope();
    if (!current) return;
    const [nextRoom, nextMessages] = await Promise.all([
      getInternalRoom(current.id, current.signal), getInternalMessages(current.id, current.signal),
    ]).catch(() => [null, []] as const);
    if (!nextRoom || !live(current)) return;
    setRoom(nextRoom); setMessages(bySequence(nextMessages));
    setInternalMentionCount(current.id, nextRoom.unreadMentionCount);
  }, [live, scope]);
  const onFrame = useCallback((frame: InternalChatFrame) => {
    if (!sessionId) return;
    if (frame.type === 'internal-chat.message.created') setMessages((current) => upsert(current, frame.message));
    if (frame.type === 'internal-chat.mention-state.changed') setInternalMentionCount(sessionId, frame.unreadMentionCount);
    if (frame.type === 'internal-chat.membership_revoked') {
      clearInternalSessionChatState(sessionId); setRoom(null); setMessages([]);
    }
  }, [sessionId]);
  // Connect only while this user holds a room; non-members never open a socket.
  useInternalSessionChatRealtime({ sessionId, enabled: enabled && room !== null, onFrame, onSnapshot: snapshot });
  return { room, setRoom, messages, setMessages, scope, live };
}

type Options = {
  sessionId: string | null | undefined;
  /** The server capability (ADR-187 §4); off means no request and no UI at all. */
  enabled: boolean;
};

/** Everything the composer, toolbar and timeline need from one session's team room. */
export type InternalSessionChatController = {
  sessionId: string;
  room: InternalRoom | null;
  members: InternalMember[];
  messages: InternalMessage[];
  /** True while the main composer writes to the team instead of the model. */
  active: boolean;
  draft: string;
  setDraft: (value: string) => void;
  /** The caller may post (a room member that is not a viewer). */
  isWriter: boolean;
  sending: boolean;
  error: string | null;
  /** Room creation was refused; the creator may re-activate it. */
  createFailed: boolean;
  showMembers: boolean;
  setShowMembers: (value: boolean | ((previous: boolean) => boolean)) => void;
  toggle: () => void;
  exit: () => void;
  send: () => Promise<void>;
  reactivate: () => Promise<void>;
  markRead: () => Promise<void>;
  onRoomChange: (room: InternalRoom | null) => void;
};

/**
 * ADR-187 team room as a composer mode. Returns null while the capability is
 * off or there is no session: no button, no socket, no request. Sending goes
 * to the room endpoint only; nothing here can reach the provider.
 */
export function useInternalSessionChat({ sessionId, enabled }: Options): InternalSessionChatController | null {
  const { t } = useTranslation('chat');
  const auth = useOptionalAuth();
  const [active, setActive] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  const { room, setRoom, messages, setMessages, scope, live } = useInternalRoom(sessionId, enabled);

  useEffect(() => {
    setActive(false); setDraft(''); setError(null); setSending(false);
    setShowMembers(false); setCreateFailed(false);
  }, [sessionId]);
  // A revoked membership drops the room; the members panel cannot stay open on it.
  useEffect(() => { if (!room) setShowMembers(false); }, [room]);

  const members = useMemo(() => room?.members ?? [], [room]);
  const selfId = Number(auth?.user?.id);
  const isWriter = members.some((member) => String(member.userId) === String(auth?.user?.id) && member.role !== 'viewer');

  const onRoomChange = useCallback((next: InternalRoom | null) => {
    setRoom(next);
    if (next && sessionId) setInternalMentionCount(sessionId, next.unreadMentionCount);
  }, [sessionId, setRoom]);

  // B-1666: each handler pins the room it started for and drops a late answer.
  const openRoom = useCallback(async () => {
    const current = scope();
    if (room || !current) return;
    const next = await createInternalRoom(current.id, current.signal).catch(() => null);
    if (!live(current)) return;
    if (!next) { setError(t('internalChat.createFailed')); setCreateFailed(true); return; }
    setCreateFailed(false);
    setRoom(next); setInternalMentionCount(current.id, next.unreadMentionCount);
  }, [live, room, scope, setRoom, t]);

  const markRead = useCallback(async () => {
    const current = scope();
    if (!current) return;
    const ordered = bySequence(await getInternalMessages(current.id, current.signal).catch(() => []));
    if (!live(current)) return;
    setMessages(ordered);
    const highest = ordered.reduce((max, message) => Math.max(max, message.sequence), 0);
    const read = highest > 0 && await markInternalRead(current.id, highest, current.signal).catch(() => false);
    if (read && live(current)) setInternalMentionCount(current.id, 0);
  }, [live, scope, setMessages]);

  const toggle = useCallback(() => {
    if (active) { setActive(false); return; }
    setActive(true); setError(null);
    if (room) void markRead(); else void openRoom();
  }, [active, markRead, openRoom, room]);
  const exit = useCallback(() => { setActive(false); setShowMembers(false); }, []);

  // A moved session's room needs its creator to re-activate it; the server alone
  // decides who that is, so a refusal is just shown. Others are re-added after.
  const reactivate = useCallback(async () => {
    const current = scope();
    if (!current || !Number.isSafeInteger(selfId)) return;
    setError(null);
    const next = await revalidateInternalRoom(current.id, [{ userId: selfId, role: 'owner' }], current.signal).catch(() => null);
    if (!live(current)) return;
    if (!next) { setError(t('internalChat.reactivateFailed')); return; }
    setCreateFailed(false); setShowMembers(true);
    setRoom(next); setInternalMentionCount(current.id, next.unreadMentionCount);
  }, [live, scope, selfId, setRoom, t]);

  const send = useCallback(async () => {
    const body = draft.trim();
    const current = scope();
    if (!body || !isWriter || sending || !current) return;
    const ids = [...body.matchAll(/@([^\s@]+)/g)]
      .flatMap((match) => members.filter((member) => member.username === match[1]).map((member) => member.userId));
    setSending(true); setError(null);
    const created = await sendInternalMessage(current.id, body, ids, current.signal).catch(() => null);
    if (!live(current)) return;
    setSending(false);
    if (!created) { setError(t('internalChat.sendFailed')); return; }
    setMessages((existing) => upsert(existing, created)); setDraft('');
  }, [draft, isWriter, live, members, scope, sending, setMessages, t]);

  if (!sessionId || !enabled) return null;
  return {
    sessionId, room, members, messages, active, draft, setDraft, isWriter, sending, error, createFailed,
    showMembers, setShowMembers, toggle, exit, send, reactivate, markRead, onRoomChange,
  };
}
