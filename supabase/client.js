import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

const supabaseUrl = 'https://pwfkmyxbsootbumikcgf.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB3ZmtteXhic29vdGJ1bWlrY2dmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyNjAwNDYsImV4cCI6MjA4OTgzNjA0Nn0.UMpYtJ5JnImHz9KNvidfRGYWUtmPnA5_zXANZVp-7i0'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)