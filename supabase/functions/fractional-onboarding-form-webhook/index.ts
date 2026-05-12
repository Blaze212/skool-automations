import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { handler } from './fractional-onboarding-form-webhook.ts';

serve(handler);
