// Friends: game-independent wrapper over the project-wide social graph.
//
// A signed-in player has a profile row with a unique shareable friend code.
// Adding a friend by code sends a request; the other player accepts from
// their profile panel. Everything goes through the LB Games API's /friends
// endpoints, which act as the signed-in caller.

import { api } from './api.js';

// Ensure the current user has a profile (and a friend code), optionally
// seeding/updating the display name. Returns { id, display_name, friend_code }.
export async function ensureProfile(displayName = null) {
  return api('/friends/profile', { method: 'POST', body: { display_name: displayName } });
}

export async function myProfile() {
  return ensureProfile(null);
}

// Add a friend by their code. Resolves to one of:
//   'requested' | 'accepted' | 'already_friends' | 'already_requested'
//   | 'self' | 'not_found'
export async function addFriendByCode(code) {
  return api('/friends/request', { method: 'POST', body: { code: (code || '').trim().toUpperCase() } });
}

// Accepted friends: [{ id, display_name, friend_code }].
export async function listFriends() {
  return (await api('/friends')) ?? [];
}

// Incoming pending requests: [{ id, display_name, friend_code }].
export async function listFriendRequests() {
  return (await api('/friends/requests')) ?? [];
}

export async function respondToRequest(requesterId, accept) {
  await api('/friends/respond', { method: 'POST', body: { requester: requesterId, accept: !!accept } });
}

export async function removeFriend(friendId) {
  await api('/friends/remove', { method: 'POST', body: { friend: friendId } });
}

export function addFriendMessage(result) {
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
