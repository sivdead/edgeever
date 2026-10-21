import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { getMemoDisplayTitle, readNotebookSiteSettings, type NotebookShare } from "@edgeever/shared";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export const NotebookSiteSettings = ({ notebookId, share, onSaved }: {
  notebookId: string; share: NotebookShare; onSaved: (data: { share: NotebookShare }) => void;
}) => {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(() => share.siteSettings ?? readNotebookSiteSettings());
  const [slug, setSlug] = useState(share.siteSlug ?? "");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const candidates = useInfiniteQuery({
    queryKey: ["notebook-site-candidates", notebookId, query],
    queryFn: ({ pageParam }) => api.listMemos({ notebookId, includeDescendants: true, q: query, cursor: pageParam, limit: 50 }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: open,
  });
  const exclusions = useInfiniteQuery({
    queryKey: ["notebook-site-exclusions", share.token],
    queryFn: ({ pageParam }) => api.listNotebookSiteExclusions(notebookId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: open,
    staleTime: 0,
  });
  const selectedHome = useQuery({
    queryKey: ["notebook-site-home-title", settings.homeMemoId],
    queryFn: () => api.getMemo(settings.homeMemoId!),
    enabled: open && Boolean(settings.homeMemoId),
    retry: false,
  });
  const save = useMutation({
    mutationFn: () => api.updateNotebookSite(notebookId, { siteSlug: slug || null, settings }),
    onSuccess: onSaved,
  });
  const exclusion = useMutation({
    mutationFn: ({ id, excluded }: { id: string; excluded: boolean }) => api.setNotebookSiteExclusion(notebookId, id, excluded),
    onSuccess: () => exclusions.refetch(),
  });
  const excluded = exclusions.data?.pages.flatMap((page) => page.memos) ?? [];
  const excludedIds = new Set(excluded.map((memo) => memo.id));
  const label = (key: string) => t(`notebookSite.${key}`);
  const title = (value: string | null) => getMemoDisplayTitle(value, t("common.untitledMemo"));
  const submit = (event: FormEvent) => { event.preventDefault(); save.mutate(); };
  return <details className="rounded-lg border p-3" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-medium">{label("settings")}</summary>
    {open && <div className="mt-4 space-y-5">
      <form className="space-y-3" onSubmit={submit}>
        <label className="block space-y-1 text-xs">{label("slug")}<Input value={slug} onChange={(e) => setSlug(e.target.value)} autoCapitalize="none" /></label>
        <label className="block space-y-1 text-xs">{label("logo")}<Input type="url" value={settings.logoUrl ?? ""} onChange={(e) => setSettings({ ...settings, logoUrl: e.target.value || null })} /></label>
        <label className="block space-y-1 text-xs">{label("footer")}<Textarea value={settings.footerText} onChange={(e) => setSettings({ ...settings, footerText: e.target.value })} /></label>
        <label className="block space-y-1 text-xs">{label("sort")}<select className="h-9 w-full rounded-md border bg-background px-2" value={settings.sortMode} onChange={(e) => setSettings({ ...settings, sortMode: e.target.value as "existing" | "title" })}>
          <option value="existing">{label("existingOrder")}</option><option value="title">{label("titleOrder")}</option>
        </select></label>
        <fieldset className="space-y-2"><legend className="text-xs">{label("headerLinks")}</legend>
          {settings.headerLinks.map((link, index) => <div className="flex flex-wrap gap-2" key={index}>
            <Input className="min-w-0 flex-1" aria-label={label("label")} value={link.label} required onChange={(e) => setSettings({ ...settings, headerLinks: settings.headerLinks.map((item, i) => i === index ? { ...item, label: e.target.value } : item) })} />
            <Input className="min-w-0 flex-1" aria-label={label("url")} type="url" required value={link.url} onChange={(e) => setSettings({ ...settings, headerLinks: settings.headerLinks.map((item, i) => i === index ? { ...item, url: e.target.value } : item) })} />
            <Button type="button" size="sm" onClick={() => setSettings({ ...settings, headerLinks: settings.headerLinks.filter((_, i) => i !== index) })}>{label("remove")}</Button>
          </div>)}
          <Button type="button" variant="outline" size="sm" onClick={() => setSettings({ ...settings, headerLinks: [...settings.headerLinks, { label: "", url: "" }] })}>{label("addLink")}</Button>
        </fieldset>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={share.passwordProtected} checked={!share.passwordProtected && settings.allowIndexing} onChange={(e) => setSettings({ ...settings, allowIndexing: e.target.checked })} />{label("indexing")}</label>
        <p className="text-xs text-muted-foreground">{label("indexingHint")}</p>
        <div className="flex items-center justify-between gap-2 text-xs"><span>{label("homepage")}: {settings.homeMemoId ? (selectedHome.data?.memo ? title(selectedHome.data.memo.title) : label("homepageSelected")) : label("directory")}</span><Button type="button" variant="outline" size="sm" onClick={() => setSettings({ ...settings, homeMemoId: null })}>{label("directory")}</Button></div>
        <Button type="submit" variant="solid" disabled={save.isPending}>{label("save")}</Button>
        {save.isSuccess && <p role="status" className="text-xs">{label("saved")}</p>}
        {save.isError && <p role="alert" className="text-xs text-destructive">{save.error.message}</p>}
      </form>
      <section className="space-y-2 border-t pt-3">
        <h3 className="text-sm font-medium">{label("excluded")}</h3><p className="text-xs text-muted-foreground">{label("exclusionHint")}</p>
        <ul className="space-y-1">{excluded.map((memo) => <li className="flex items-center justify-between gap-2 text-xs" key={memo.id}><span className="min-w-0 break-words">{title(memo.title)}</span><Button variant="outline" size="sm" disabled={exclusion.isPending} onClick={() => exclusion.mutate({ id: memo.id, excluded: false })}>{label("restore")}</Button></li>)}</ul>
        {exclusions.hasNextPage && <Button variant="outline" size="sm" disabled={exclusions.isFetchingNextPage} onClick={() => void exclusions.fetchNextPage()}>{label("more")}</Button>}
        {(exclusions.isError || exclusion.isError) && <p role="alert" className="text-xs text-destructive">{t("sharing.error")} <Button variant="outline" size="sm" onClick={() => void exclusions.refetch()}>{t("sharing.retry")}</Button></p>}
      </section>
      <section className="space-y-2 border-t pt-3">
        <label className="block space-y-1 text-xs">{label("chooseNotes")}<Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <ul className="max-h-60 space-y-2 overflow-y-auto">{candidates.data?.pages.flatMap((page) => page.memos).map((memo) => <li key={memo.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs">
          <span className="min-w-0 flex-1 break-words">{title(memo.title)}</span>
          <Button size="sm" variant="outline" disabled={excludedIds.has(memo.id)} onClick={() => { setSettings({ ...settings, homeMemoId: memo.id }); save.reset(); }}>{settings.homeMemoId === memo.id ? label("homepageSelected") : label("homepage")}</Button>
          <Button size="sm" variant="outline" disabled={exclusion.isPending || excludedIds.has(memo.id)} onClick={() => exclusion.mutate({ id: memo.id, excluded: true })}>{label("exclude")}</Button>
        </li>)}</ul>
        {candidates.isPending && <p role="status" className="text-xs">{t("sharing.publicLoading")}</p>}
        {candidates.isError && <p role="alert" className="text-xs">{t("sharing.error")} <Button size="sm" onClick={() => void candidates.refetch()}>{t("sharing.retry")}</Button></p>}
        {candidates.hasNextPage && <Button variant="outline" size="sm" disabled={candidates.isFetchingNextPage} onClick={() => void candidates.fetchNextPage()}>{label("more")}</Button>}
      </section>
    </div>}
  </details>;
};
