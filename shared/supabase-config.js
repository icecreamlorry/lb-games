// Supabase project credentials — shared across every LB Games title.
//
// The anon key is safe in client code; access is controlled by Row Level
// Security. Find it in the Supabase dashboard under Project Settings → API.
//
// Per-game identity (slug / name) lives in each game's window.LB_CONFIG,
// NOT here. This file only knows about the Supabase project itself.

export const SUPABASE_URL      = 'https://ymeobjtrhxbwywcvaova.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_xic2yc7GGMKvfs6D09MzQA_rcGvFMwT';

export function configReady() {
  return SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.startsWith('PASTE_');
}
