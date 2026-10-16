'use strict';
(()=>{
  const root=document.querySelector('[data-destination-country]');
  if(!root)return;
  const iso=root.dataset.destinationCountry;
  const country=root.dataset.destinationName;
  const api=window.HOPON_API||'https://api.hopon.fr';
  const host=document.querySelector('#live-plans');
  const money=value=>new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format(Number(value));
  const esc=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const dataLabel=mb=>!Number(mb)?'Données selon le forfait':Number(mb)>=1024?`${Number(mb/1024).toLocaleString('fr-FR',{maximumFractionDigits:1})} Go`:`${Number(mb)} Mo`;
  const durationLabel=days=>Number(days)>0?`${Number(days)} jours`:'Durée indiquée avant achat';

  async function load(){
    try{
      const response=await fetch(`${api}/api/catalog/products?country=${encodeURIComponent(iso)}`,{cache:'no-store',headers:{'X-Hopon-Language':'fr'}});
      if(!response.ok)throw new Error();
      const plans=await response.json();
      if(!Array.isArray(plans)||!plans.length){host.innerHTML='<div class="plan-status">Aucun forfait n’est publié pour cette destination aujourd’hui. Revenez prochainement ou consultez les autres destinations HopOn.</div>';return;}
      host.innerHTML=plans.map(plan=>`<article class="live-plan"><div><p class="eyebrow">eSIM prépayée</p><h3>${esc(plan.display_name||`eSIM ${country}`)}</h3></div><p>${esc(dataLabel(plan.data_amount_mb))} · ${esc(durationLabel(plan.duration_days))} · Sans renouvellement automatique</p><div class="live-plan-price"><strong>${money(plan.selling_price_ttc)}</strong><small>TTC</small></div><a class="button" href="/?destination=${encodeURIComponent(iso)}#destinations">Choisir ce forfait</a></article>`).join('');
      const low=Math.min(...plans.map(plan=>Number(plan.selling_price_ttc)).filter(Number.isFinite));
      if(Number.isFinite(low))document.querySelector('[data-live-price]').textContent=`Dès ${money(low)} TTC`;
      const offers=plans.map(plan=>({'@type':'Offer',price:Number(plan.selling_price_ttc).toFixed(2),priceCurrency:String(plan.currency||'EUR'),availability:'https://schema.org/InStock',url:`https://hopon.fr/?destination=${encodeURIComponent(iso)}#destinations`,seller:{'@type':'Organization',name:'HopOn'}}));
      const schema=document.createElement('script');schema.type='application/ld+json';schema.text=JSON.stringify({'@context':'https://schema.org','@type':'Product',name:`eSIM ${country}`,description:`Forfaits de données mobiles prépayés pour voyager en ${country}.`,brand:{'@type':'Brand',name:'HopOn'},category:'eSIM de voyage',offers});document.head.appendChild(schema);
    }catch(_){host.innerHTML='<div class="plan-status">Les forfaits sont momentanément indisponibles. Le prix affiché au moment du paiement restera le prix TTC définitif.</div>';}
  }
  load();
})();
