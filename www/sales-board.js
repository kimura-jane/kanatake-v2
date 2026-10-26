/* Read-only public status viewer for Capacitor / Android PWA.
   All visibility decisions are made by the server, including JST 22:00 cutoff. */
(function () {
  'use strict';
  const api=(window.KANATAKE_SALES_API_BASE||'').replace(/\/$/,'');
  const card=document.getElementById('sales-board-section');
  const image=document.getElementById('sales-board-image');
  const caption=document.getElementById('sales-board-updated');
  if(!api||!card||!image||!caption)return;
  let currentUrl='',sequence=0;
  function afterJstClosingTime(){return new Date(Date.now()+9*3600000).getUTCHours()>=22;}
  async function refresh(){
    if(afterJstClosingTime()){card.style.display='none';currentUrl='';}
    const ticket=++sequence;
    try {
      const response=await fetch(api+'/public/current',{cache:'no-store'});
      if(!response.ok)throw new Error('sales unavailable');
      const data=await response.json();
      if(ticket!==sequence||afterJstClosingTime())return;
      if(!data.active||!data.board_url){card.style.display='none';currentUrl='';return;}
      if(data.board_url===currentUrl){card.style.display='block';return;}
      card.style.display='none';
      const next=new Image();
      next.onload=function(){
        if(ticket!==sequence||afterJstClosingTime())return;
        image.src=data.board_url;currentUrl=data.board_url;
        caption.textContent=data.updated_at ? '更新：'+new Date(data.updated_at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit'}) : '';
        card.style.display='block';
      };
      next.onerror=function(){if(ticket===sequence)card.style.display='none';};
      next.src=data.board_url;
    }catch(e){if(ticket===sequence){card.style.display='none';currentUrl='';}}
  }
  function scheduleJstClose(){
    const shifted=new Date(Date.now()+9*3600000);
    const millisecondsToday=((shifted.getUTCHours()*60+shifted.getUTCMinutes())*60+shifted.getUTCSeconds())*1000+shifted.getUTCMilliseconds();
    let delay=22*3600000-millisecondsToday;
    if(delay<=0)delay+=24*3600000;
    setTimeout(function(){card.style.display='none';currentUrl='';++sequence;refresh();scheduleJstClose();},delay);
  }
  scheduleJstClose();
  refresh();
  setInterval(refresh,30000);
  document.addEventListener('visibilitychange',function(){if(!document.hidden)refresh();});
})();
