import { AlertOctagon, CheckCircle2 } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, post } from '../api';
import { Badge, Button, Card, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';

interface Alert {
  id: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  status: string;
  title: string;
  message: string;
  firstSeenAt: string;
  lastSeenAt: string;
}
export function AlertsPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['alerts'],
    queryFn: () => api<Alert[]>('/api/v1/alerts'),
    refetchInterval: 15_000,
  });
  const resolve = useMutation({
    mutationFn: (id: string) => post(`/api/v1/alerts/${id}/resolve`),
    onSuccess: async () => client.invalidateQueries({ queryKey: ['alerts'] }),
  });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} />;
  return (
    <>
      <PageHeader title={t('alerts')} subtitle="Operational and financial safety signals" />
      <div className="alert-list">
        {query.data?.length ? (
          query.data.map((alert) => (
            <Card key={alert.id} className={`alert-card severity-${alert.severity.toLowerCase()}`}>
              <AlertOctagon size={22} />
              <div>
                <div className="alert-title">
                  <h2>{alert.title}</h2>
                  <Badge
                    tone={
                      alert.severity === 'CRITICAL'
                        ? 'bad'
                        : alert.severity === 'WARNING'
                          ? 'warn'
                          : 'info'
                    }
                  >
                    {alert.severity}
                  </Badge>
                  <Badge>{alert.status}</Badge>
                </div>
                <p>{alert.message}</p>
                <span>
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(new Date(alert.lastSeenAt))}
                </span>
              </div>
              {alert.status === 'OPEN' && (
                <Button variant="ghost" onClick={() => resolve.mutate(alert.id)}>
                  <CheckCircle2 size={16} />
                  {t('resolve')}
                </Button>
              )}
            </Card>
          ))
        ) : (
          <Card>
            <Empty />
          </Card>
        )}
      </div>
    </>
  );
}
