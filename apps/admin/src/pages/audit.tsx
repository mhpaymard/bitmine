import { Fingerprint } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { Badge, Card, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';

interface Audit {
  id: string;
  action: string;
  entityType: string;
  entityId?: string;
  eventHash: string;
  previousHash?: string;
  createdAt: string;
  actor?: { displayName: string; email: string };
}
export function AuditPage() {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['audit'],
    queryFn: () => api<Audit[]>('/api/v1/audit?limit=200'),
  });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} />;
  return (
    <>
      <PageHeader title={t('audit')} subtitle="Append-only, hash-chained administrative evidence" />
      <Card>
        {query.data?.length ? (
          <div className="audit-timeline">
            {query.data.map((event) => (
              <div key={event.id}>
                <div className="timeline-icon">
                  <Fingerprint size={15} />
                </div>
                <div>
                  <div>
                    <strong>{event.action}</strong>
                    <Badge>{event.entityType}</Badge>
                  </div>
                  <p>
                    {event.actor?.displayName ?? 'System'} · {event.entityId ?? '—'}
                  </p>
                  <code dir="ltr">{event.eventHash}</code>
                </div>
                <time>
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  }).format(new Date(event.createdAt))}
                </time>
              </div>
            ))}
          </div>
        ) : (
          <Empty />
        )}
      </Card>
    </>
  );
}
