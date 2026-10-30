from pathlib import Path
import urllib.request, concurrent.futures, json, sys
root=(Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parent.parent/'artifacts/reading-lab/corpus')/'sources';root.mkdir(parents=True,exist_ok=True)
sources=[('folger-macbeth','https://flgr.sh/txtfssMacpdf'),('folger-midsummer','https://flgr.sh/txtfssMNDpdf'),('ibsen-dolls-house','https://www2.hf.uio.no/polyglotta/public/media/libraries/file/10/A%20Dolls%20House-%20Henrik%20Ibsen.pdf'),('archive-dolls-house','https://archive.org/download/dollshouseplay00ibseiala/dollshouseplay00ibseiala.pdf')]
def fetch(item):
 name,url=item;target=root/(name+'.pdf')
 try:
  if not target.exists():
   request=urllib.request.Request(url,headers={'User-Agent':'LightingDesign-LocalImportTesting/1.0'})
   with urllib.request.urlopen(request,timeout=60) as response:
    data=response.read(100*1024*1024)
    if not data.startswith(b'%PDF-'):raise ValueError('Not a PDF')
    target.write_bytes(data)
  return dict(id=name,url=url,bytes=target.stat().st_size)
 except Exception as error:return dict(id=name,url=url,error=str(error))
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(fetch,sources))
(root/'sources.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results,indent=2))
