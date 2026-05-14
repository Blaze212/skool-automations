import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { handler } from './linkedin-tracker-provision.ts';

serve(handler);
