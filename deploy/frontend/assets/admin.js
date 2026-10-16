'use strict';
const API=window.HOPON_API||'https://api.hopon.fr';
let token=sessionStorage.getItem('hopon_admin_token')||'';
let catalogProducts=[];
const q=selector=>document.querySelector(selector);
const money=value=>new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format(Number(value||0));
const moneyOrMissing=value=>value===null||value===undefined||value===''?'Non fourni':money(value);
const esc=value=>String(value??'').replace(/[&<>'"]/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[character]));

async function api(path,options={}){
  const {timeoutMs=15000,...requestOptions}=options;
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const isBinary=requestOptions.body instanceof FormData||requestOptions.body instanceof Blob;
    const response=await fetch(API+path,{cache:'no-store',...requestOptions,signal:controller.signal,headers:{...(isBinary?{}:{'Content-Type':'application/json'}),...(token?{Authorization:`Bearer ${token}`}:{}) ,...(requestOptions.headers||{})}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){if(response.status===401)logout();throw new Error(data.error||'Erreur serveur');}
    return data;
  }catch(error){
    if(error.name==='AbortError')throw new Error('L’API ne répond pas. Réessayez dans quelques instants.');
    if(error instanceof TypeError)throw new Error('Connexion à l’API impossible.');
    throw error;
  }finally{clearTimeout(timeout);}
}

function toast(message){const element=q('#toast');element.textContent=message;element.classList.add('on');setTimeout(()=>element.classList.remove('on'),4000);}
function showApp(){q('#login-screen').hidden=true;q('#admin-app').hidden=false;loadDashboard();}
function logout(){token='';sessionStorage.removeItem('hopon_admin_token');q('#admin-app').hidden=true;q('#login-screen').hidden=false;}

q('#login-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;q('#login-error').textContent='';try{const result=await api('/api/admin/login',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))});token=result.token;sessionStorage.setItem('hopon_admin_token',token);showApp();}catch(error){q('#login-error').textContent=error.message;}finally{button.disabled=false;}});
q('#logout').onclick=logout;

const titles={dashboard:'Vue d’ensemble',sales:'Ventes',catalog:'Catalogue et prix',stock:'Parc eSIM'};
function switchView(name){document.querySelectorAll('.view').forEach(view=>view.classList.toggle('active',view.id===`view-${name}`));document.querySelectorAll('.sidebar nav button').forEach(button=>button.classList.toggle('active',button.dataset.view===name));q('#view-title').textContent=titles[name];q('.sidebar').classList.remove('open');if(name==='sales')loadSales();if(name==='catalog')loadCatalog();if(name==='stock')loadStock();}
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>switchView(button.dataset.view));
document.querySelectorAll('[data-go]').forEach(button=>button.onclick=()=>switchView(button.dataset.go));
q('#mobile-nav').onclick=()=>q('.sidebar').classList.toggle('open');

async function loadDashboard(){try{const data=await api('/api/admin/dashboard');const values=[data.orders_30d,money(data.revenue_ttc_30d),data.delivered,data.attention];q('#metrics').querySelectorAll('strong').forEach((element,index)=>element.textContent=values[index]??0);renderSales(q('#recent-sales'),data.recent_orders||[]);}catch(error){toast(error.message);}}
function statusLabel(status){return ({paid:'Payée',processing:'En préparation',delivered:'Livrée',failed:'Échec',refunded:'Remboursée'}[status]||status||'—');}
function renderSales(container,orders){
  if(!orders.length){container.innerHTML='<div class="empty-admin">Aucune vente pour le moment.</div>';return;}
  container.innerHTML=`<div class="table-wrap"><table class="admin-table"><thead><tr><th>Commande</th><th>Client</th><th>Forfait</th><th>Total TTC</th><th>Statut</th><th>Date</th></tr></thead><tbody>${orders.map(order=>`<tr><td><b>${esc(order.order_number)}</b></td><td>${esc(order.customer_name||'—')}<small>${esc(order.customer_email)}</small></td><td>${esc(order.product_name||'—')}<small>${order.order_type==='recharge'?'Recharge · ':''}${esc(order.country_name||'')}</small></td><td><b>${money(order.total_ttc)}</b></td><td><span class="status ${esc(order.status)}">${esc(statusLabel(order.status))}</span>${order.status==='failed'?`<small class="failure-reason">${esc(order.failure_reason||'Motif indisponible')}</small><button class="retry-delivery" data-retry-delivery="${esc(order.id)}">Relancer la livraison</button>`:''}</td><td>${new Date(order.created_at).toLocaleDateString('fr-FR')}</td></tr>`).join('')}</tbody></table></div>`;
  container.querySelectorAll('[data-retry-delivery]').forEach(button=>button.onclick=async()=>{
    button.disabled=true;button.textContent='Relance…';
    try{const result=await api(`/api/admin/orders/${encodeURIComponent(button.dataset.retryDelivery)}/retry-delivery`,{method:'POST'});toast(result.message);setTimeout(()=>container.id==='recent-sales'?loadDashboard():loadSales(),2500);}
    catch(error){toast(error.message);button.disabled=false;button.textContent='Relancer la livraison';}
  });
}
async function loadSales(){q('#sales-table').innerHTML='<div class="empty-admin">Chargement…</div>';try{renderSales(q('#sales-table'),await api('/api/admin/orders'));}catch(error){toast(error.message);}}
q('#refresh-sales').onclick=loadSales;

async function loadCatalog(){
  q('#catalog-table').innerHTML='<div class="empty-admin">Chargement…</div>';
  try{
    const [products,changes,settings]=await Promise.all([api('/api/admin/products'),api('/api/admin/catalog/changes'),api('/api/admin/catalog/settings')]);
    catalogProducts=products;
    if(Number.isFinite(Number(settings.default_markup_percent)))q('#bulk-markup').value=Number(settings.default_markup_percent);
    renderLastSync(settings.last_sync);renderLastImport(settings.last_import);
    fillCountryFilter(products);
    renderCatalog(products);
    renderChanges(changes);
  }catch(error){toast(error.message);}
}

function renderLastSync(lastSync){
  const element=q('#last-catalog-sync');
  element.hidden=!lastSync;
  if(!lastSync)return;
  const date=new Date(lastSync.finished_at||lastSync.started_at).toLocaleString('fr-FR');
  const detail=lastSync.status==='success'?`${lastSync.products_received||0} forfait(s) reçu(s)`:`échec : ${lastSync.error_message||'raison indisponible'}`;
  element.textContent=`Dernière synchronisation automatique : ${date} — ${detail}`;
  element.classList.toggle('sync-failed',lastSync.status!=='success');
}

function renderLastImport(lastImport){
  const element=q('#last-catalog-import');
  element.hidden=!lastImport;
  if(!lastImport)return;
  const date=new Date(lastImport.finished_at||lastImport.started_at).toLocaleString('fr-FR');
  element.textContent=`Dernier import : ${lastImport.filename} — ${date} — ${lastImport.products_received||0} forfait(s) lu(s)`;
}

function fillCountryFilter(products){
  const select=q('#catalog-country-filter');
  const current=select.value;
  const countries=[...new Map(products.map(product=>[product.country_iso2||'',product.country_name||product.country_iso2||'Monde'])).entries()].sort((a,b)=>a[1].localeCompare(b[1],'fr'));
  select.innerHTML='<option value="">Tous les pays</option>'+countries.map(([code,name])=>`<option value="${esc(code)}">${esc(name)}</option>`).join('');
  if([...select.options].some(option=>option.value===current))select.value=current;
}

function renderCatalog(products){
  if(!products.length){q('#catalog-table').innerHTML='<div class="empty-admin">Aucun produit. Lancez la synchronisation Transatel.</div>';return;}
  q('#catalog-table').innerHTML=`<div class="table-wrap"><table class="admin-table catalog-table"><thead><tr><th class="check-cell"><input id="catalog-check-all" type="checkbox" aria-label="Tout sélectionner"></th><th>Destination / forfait</th><th>Achat HT</th><th>Conseillé HT</th><th>Mode</th><th>Majoration</th><th>Vente HT</th><th>TVA</th><th>Prix TTC</th><th>Ubigi TTC</th><th>Publié</th><th></th></tr></thead><tbody>${products.map(product=>`<tr data-product="${esc(product.id)}" data-country="${esc(product.country_iso2||'')}" data-search="${esc(`${product.country_name||''} ${product.country_iso2||''} ${product.name||''} ${product.description||''}`.toLocaleLowerCase('fr'))}" class="${product.needs_review?'needs-review':''}"><td class="check-cell"><input class="product-select" type="checkbox" aria-label="Sélectionner ${esc(product.name)}"></td><td><b>${esc(product.country_name||product.country_iso2||'Zone')} — ${esc(product.name)}</b><small>${product.data_amount_mb?`${Number(product.data_amount_mb/1024).toLocaleString('fr-FR',{maximumFractionDigits:1})} Go · `:'Illimité · '}${esc(product.duration_days||'—')} jours${product.needs_review?' · À vérifier':''}</small></td><td><input class="price-input purchase-ht" type="number" min="0" step="0.0001" value="${esc(product.purchase_price_ht??'')}" placeholder="Non fourni" aria-label="Prix d’achat HT"></td><td><b class="recommended-ht">${moneyOrMissing(product.recommended_price_ht)}</b></td><td><select class="pricing-mode" aria-label="Mode de tarification"><option value="manual" ${product.pricing_mode!=='markup'?'selected':''}>Manuel</option><option value="markup" ${product.pricing_mode==='markup'?'selected':''}>Automatique</option></select></td><td><input class="price-input markup" type="number" min="0" max="10000" step="0.1" value="${esc(product.markup_percent??'')}" placeholder="0" aria-label="Majoration en pourcentage"> %</td><td><input class="price-input sell-ht" type="number" min="0" step="0.01" value="${esc(product.selling_price_ht??'')}" aria-label="Prix de vente HT"></td><td><input class="price-input vat-input vat" type="number" min="0" max="100" step="0.1" value="${esc(product.vat_rate??20)}" aria-label="TVA"> %<small class="vat-amount">${money(product.vat_amount)}</small></td><td><b class="ttc">${money(product.selling_price_ttc)}</b></td><td>${moneyOrMissing(product.supplier_retail_price_ttc)}</td><td><label class="publish-toggle"><input class="published" type="checkbox" ${product.is_published?'checked':''}> Oui</label></td><td><button class="save-price">Enregistrer</button></td></tr>`).join('')}</tbody></table></div>`;
  q('#catalog-table').querySelectorAll('tr[data-product]').forEach(row=>{
    const calculate=()=>{const ht=Number(row.querySelector('.sell-ht').value||0),vat=Number(row.querySelector('.vat').value||0);row.querySelector('.vat-amount').textContent=money(ht*vat/100);row.querySelector('.ttc').textContent=money(ht*(1+vat/100));};
    const calculateFromMarkup=()=>{if(row.querySelector('.pricing-mode').value!=='markup')return calculate();const product=catalogProducts.find(item=>item.id===row.dataset.product);const recommended=Number(product?.recommended_price_ht||0),purchase=Number(row.querySelector('.purchase-ht').value||0),markup=row.querySelector('.markup').value,base=recommended>0?recommended:purchase;if(base>0&&markup!=='')row.querySelector('.sell-ht').value=(base*(1+Number(markup)/100)).toFixed(2);calculate();};
    row.querySelector('.purchase-ht').addEventListener('input',calculateFromMarkup);
    row.querySelector('.markup').addEventListener('input',()=>{row.querySelector('.pricing-mode').value='markup';calculateFromMarkup();});
    row.querySelector('.pricing-mode').addEventListener('change',calculateFromMarkup);
    row.querySelector('.sell-ht').addEventListener('input',()=>{row.querySelector('.pricing-mode').value='manual';calculate();});
    row.querySelector('.vat').addEventListener('input',calculate);
    row.querySelector('.save-price').onclick=()=>saveProduct(row);
  });
  q('#catalog-check-all').onchange=event=>visibleRows().forEach(row=>{row.querySelector('.product-select').checked=event.target.checked;});
  applyCatalogFilters();
}

function visibleRows(){return [...q('#catalog-table').querySelectorAll('tr[data-product]')].filter(row=>!row.hidden);}
function selectedIds(){return [...q('#catalog-table').querySelectorAll('tr[data-product]')].filter(row=>row.querySelector('.product-select').checked).map(row=>row.dataset.product);}
function applyCatalogFilters(){
  const search=q('#catalog-search').value.trim().toLocaleLowerCase('fr');
  const country=q('#catalog-country-filter').value;
  q('#catalog-table').querySelectorAll('tr[data-product]').forEach(row=>{row.hidden=Boolean((country&&row.dataset.country!==country)||(search&&!row.dataset.search.includes(search)));});
  const master=q('#catalog-check-all');if(master)master.checked=false;
}
q('#catalog-search').addEventListener('input',applyCatalogFilters);
q('#catalog-country-filter').addEventListener('change',applyCatalogFilters);
q('#select-visible').onclick=()=>{const rows=visibleRows();const selectAll=rows.some(row=>!row.querySelector('.product-select').checked);rows.forEach(row=>{row.querySelector('.product-select').checked=selectAll;});const master=q('#catalog-check-all');if(master)master.checked=selectAll;};

async function saveProduct(row){
  const button=row.querySelector('.save-price');button.disabled=true;
  try{
    const purchaseInput=row.querySelector('.purchase-ht').value.trim();
    const markupInput=row.querySelector('.markup').value.trim();
    const body={purchase_price_ht:purchaseInput===''?null:Number(purchaseInput),markup_percent:markupInput===''?null:Number(markupInput),selling_price_ht:Number(row.querySelector('.sell-ht').value),pricing_mode:row.querySelector('.pricing-mode').value,vat_rate:Number(row.querySelector('.vat').value),is_published:row.querySelector('.published').checked};
    const product=await api(`/api/admin/products/${row.dataset.product}/pricing`,{method:'PUT',body:JSON.stringify(body)});
    row.querySelector('.purchase-ht').value=product.purchase_price_ht??'';
    row.querySelector('.markup').value=product.markup_percent??'';
    row.querySelector('.sell-ht').value=product.selling_price_ht??'';
    row.querySelector('.pricing-mode').value=product.pricing_mode==='markup'?'markup':'manual';
    row.querySelector('.vat-amount').textContent=money(product.vat_amount);
    row.querySelector('.ttc').textContent=money(product.selling_price_ttc);
    toast(`Tarif enregistré — achat HT : ${moneyOrMissing(product.purchase_price_ht)}`);
  }catch(error){toast(error.message);}finally{button.disabled=false;}
}

async function bulkPublish(isPublished){
  const ids=selectedIds();
  if(!ids.length){toast('Sélectionnez au moins un forfait');return;}
  const button=isPublished?q('#publish-selected'):q('#unpublish-selected');button.disabled=true;
  try{
    const result=await api('/api/admin/products/bulk-publish',{method:'POST',body:JSON.stringify({ids,is_published:isPublished})});
    toast(isPublished?`${result.updated} forfait(s) publié(s)${result.skipped?` — ${result.skipped} incomplet(s)`:''}`:`${result.updated} forfait(s) dépublié(s)`);
    await loadCatalog();
  }catch(error){toast(error.message);}finally{button.disabled=false;}
}
q('#publish-selected').onclick=()=>bulkPublish(true);
q('#unpublish-selected').onclick=()=>bulkPublish(false);

async function applyMarkup({publish=false,allProducts=false}={}){
  const ids=allProducts?[]:selectedIds();
  const markup=Number(q('#bulk-markup').value);
  if(!allProducts&&!ids.length){toast('Sélectionnez au moins un forfait');return;}
  if(!Number.isFinite(markup)||markup<0){toast('Saisissez un pourcentage valide');return;}
  const button=allProducts?(publish?q('#apply-markup-all-publish'):q('#apply-markup-all')):q('#apply-markup');button.disabled=true;
  try{
    const result=await api('/api/admin/products/bulk-markup',{method:'POST',body:JSON.stringify({ids,all_products:allProducts,markup_percent:markup,publish})});
    toast(`${result.updated} prix recalculé(s) avec ${markup} %${publish?` et publié(s)`:''}${result.skipped?` — ${result.skipped} incomplet(s)`:''}`);
    await loadCatalog();
    if(publish)await loadDashboard();
  }catch(error){toast(error.message);}finally{button.disabled=false;}
}
q('#apply-markup').onclick=()=>applyMarkup();
q('#apply-markup-all').onclick=()=>applyMarkup({allProducts:true});
q('#apply-markup-all-publish').onclick=()=>applyMarkup({allProducts:true,publish:true});

const changeLabels={new_country:'Nouvelle destination',new_destination:'Nouvelle destination',new_product:'Nouveau forfait',price_changed:'Prix d’achat modifié',recommended_price_changed:'Prix conseillé modifié',supplier_retail_price_changed:'Prix Ubigi modifié',product_changed:'Forfait modifié',product_removed:'Forfait retiré'};
function renderChanges(changes){
  const panel=q('#catalog-changes');
  panel.hidden=!changes.length;
  q('#catalog-change-count').textContent=changes.length;
  q('#catalog-change-list').innerHTML=changes.slice(0,50).map(change=>`<article><span class="change-badge ${esc(change.change_type)}">${esc(changeLabels[change.change_type]||'Modification')}</span><div><b>${esc(change.country_name||change.country_iso2||'Catalogue')} — ${esc(change.product_name||change.new_value||change.transatel_product_id||'Élément')}</b>${change.field_name?`<small>${esc(change.field_name)} : ${esc(change.old_value||'—')} → ${esc(change.new_value||'—')}</small>`:''}</div><time>${new Date(change.created_at).toLocaleString('fr-FR')}</time></article>`).join('');
}
q('#review-changes').onclick=async()=>{const button=q('#review-changes');button.disabled=true;try{await api('/api/admin/catalog/changes/reviewed',{method:'POST'});renderChanges([]);await loadDashboard();toast('Changements marqués comme vérifiés');}catch(error){toast(error.message);}finally{button.disabled=false;}};

q('#sync-catalog').onclick=async()=>{const button=q('#sync-catalog');button.disabled=true;try{const result=await api('/api/admin/catalog/sync',{method:'POST',timeoutMs:60000});toast(`Synchronisation terminée : ${result.created} ajout(s), ${result.updated} modification(s), ${result.changes} alerte(s)`);await loadCatalog();await loadDashboard();}catch(error){toast(error.message);}finally{button.disabled=false;}};
q('#import-prices').onclick=()=>q('#price-file').click();
q('#price-file').onchange=async event=>{
  const file=event.target.files?.[0];if(!file)return;
  const button=q('#import-prices');button.disabled=true;button.textContent='Import en cours…';
  try{
    const result=await api('/api/admin/catalog/import-prices',{method:'POST',body:file,headers:{'Content-Type':file.type||'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','X-File-Name':encodeURIComponent(file.name)},timeoutMs:120000});
    toast(`${result.products_recalculated} prix recalculé(s) — ${result.products_created} nouveau(x) forfait(s) — ${result.prices_changed} changement(s) de prix — ${result.new_destinations} nouvelle(s) destination(s)`);
    await loadCatalog();await loadDashboard();
  }catch(error){toast(error.message);}finally{button.disabled=false;button.textContent='Importer le catalogue mensuel';event.target.value='';}
};

async function loadStock(){
  try{
    const data=await api('/api/admin/esim-stock');
    const values=[data.available,data.reserved,data.assigned,data.unavailable];
    q('#stock-metrics').querySelectorAll('strong').forEach((element,index)=>element.textContent=Number(values[index]||0));
    const element=q('#last-stock-import');element.hidden=!data.last_import;
    if(data.last_import){const imported=data.last_import;element.textContent=`Dernier import : ${imported.filename} — ${new Date(imported.finished_at||imported.started_at).toLocaleString('fr-FR')} — ${imported.profiles_received} profil(s) lu(s), ${imported.available_after_import} disponible(s)`;}
  }catch(error){toast(error.message);}
}
q('#import-stock').onclick=()=>q('#stock-file').click();
q('#stock-file').onchange=async event=>{
  const file=event.target.files?.[0];if(!file)return;
  const button=q('#import-stock');button.disabled=true;button.textContent='Import en cours…';
  try{
    const result=await api('/api/admin/esim-stock/import',{method:'POST',body:file,headers:{'Content-Type':'text/csv','X-File-Name':encodeURIComponent(file.name)},timeoutMs:120000});
    toast(`${result.profiles_received} profil(s) lu(s) — ${result.profiles_inserted} ajouté(s) — ${result.available} disponible(s)`);
    await loadStock();
  }catch(error){toast(error.message);}finally{button.disabled=false;button.textContent='Importer le fichier parc CSV';event.target.value='';}
};
if(token)showApp();
