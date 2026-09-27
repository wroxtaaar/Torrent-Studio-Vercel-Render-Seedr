                    )}
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Files already downloaded to your Seedr account stay visible here, even after refreshing Torrent Studio.
                  </p>
                  {seedrConfigured && (
                    seedrQuota ? (
                      <div className="mt-3 grid grid-cols-3 gap-2 max-w-xl">
                        <div className="rounded-lg bg-slate-900/80 border border-slate-800 px-3 py-2">
                          <div className="text-[10px] uppercase tracking-wide text-slate-500">Consumed</div>
                          <div className="text-sm font-bold text-slate-100 mt-0.5">{formatBytes(seedrQuota.usedSpace)}</div>
                        </div>
                        <div className="rounded-lg bg-slate-900/80 border border-slate-800 px-3 py-2">
                          <div className="text-[10px] uppercase tracking-wide text-slate-500">Remaining</div>
                          <div className={`text-sm font-bold mt-0.5 ${seedrQuota.remainingSpace > 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                            {formatQuotaBytes(seedrQuota.remainingSpace)}
                          </div>
                        </div>
                        <div className="rounded-lg bg-slate-900/80 border border-slate-800 px-3 py-2">
                          <div className="text-[10px] uppercase tracking-wide text-slate-500">Total</div>
                          <div className="text-sm font-bold text-slate-100 mt-0.5">{formatBytes(seedrQuota.maxSpace)}</div>
                        </div>
                      </div>
                    ) : null
                  )}
                </div>
                <button
                  type="button"
                  onClick={loadSeedrLibrary}
                  disabled={seedrLoading}
                  className="shrink-0 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition"
                >