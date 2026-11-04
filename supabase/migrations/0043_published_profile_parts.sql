-- Publishing a profile part does not declare a matching purpose or availability.
alter table public.twin_discovery_signals drop constraint twin_discovery_signals_purpose_check;
alter table public.twin_discovery_signals add constraint twin_discovery_signals_purpose_check
 check (purpose in ('profile','help','collaborate','cofounder'));
