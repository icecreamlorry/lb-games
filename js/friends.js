// Friends: a thin, game-independent wrapper over the project-wide social
// graph (see supabase/friends.sql). Like auth.js it knows nothing about any
// particular game — copy it as-is into other projects on the same Supabase
// project and the friends/profile layer works unchanged.
//
// A signed-in player has a profile row carrying a unique, shareable friend
// code. Adding a friend by code sends a request; the other player accepts it
// from their profile panel. Everything goes through SECURITY DEFINER RPCs so
// the underlying tables stay locked down.

import { supabase } from './supabaseClient.js';

// Ensure the current user has a profile (and a friend code), optionally
// seeding/updating the display name. Returns { id, display_name, friend_code }.
export async function ensureProfile(displayName = null) {
  const { data, error } = await supabase().rpc('ensure_profile', {
    p_display_name: displayName,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function myProfile() {
  return ensureProfile(null);
}

// Add a friend by their code. Resolves to one of:
//   'requested' | 'accepted' | 'already_friends' | 'already_requested'
//   | 'self' | 'not_found'
export async function addFriendByCode(code) {
  const { data, error } = await supabase().rpc('send_friend_request', {
    p_code: (code || '').trim().toUpperCase(),
  });
  if (error) throw error;
  return data;
}

// Accepted friends: [{ id, display_name, friend_code }].
export async function listFriends() {
  const { data, error } = await supabase().rpc('list_friends');
  if (error) throw error;
  return data ?? [];
}

// Incoming pending requests: [{ id, display_name, friend_code }].
export async function listFriendRequests() {
  const { data, error } = await supabase().rpc('list_friend_requests');
  if (error) throw error;
  return data ?? [];
}

export async function respondToRequest(requesterId, accept) {
  const { error } = await supabase().rpc('respond_friend_request', {
    p_requester: requesterId,
    p_accept: !!accept,
  });
  if (error) throw error;
}

export async function removeFriend(friendId) {
  const { error } = await supabase().rpc('remove_friend', { p_friend: friendId });
  if (error) throw error;
}

// Friendly one-liner for an addFriendByCode result.
export function addFriendMessage(result, codeOwnerName) {
  switch (result) {
    case 'requested':         return 'Friend request sent.';
    case 'accepted':          return 'You are now friends!';
    case 'already_friends':   return "You're already friends.";
    case 'already_requested': return 'Request already sent — waiting for them to accept.';
    case 'self':              return "That's your own code.";
    case 'not_found':         return 'No player found with that code.';
    default:                  return 'Done.';
  }
}
