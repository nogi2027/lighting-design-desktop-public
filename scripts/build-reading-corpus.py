"""Build the local reading lab. Downloads stay outside the product bundle."""
from pathlib import Path
import json, hashlib, sys
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from pypdf import PdfReader, PdfWriter
import pypdfium2 as pdfium
from PIL import Image, ImageEnhance, ImageFilter

root=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parent.parent/'artifacts/reading-lab/corpus'; root.mkdir(parents=True,exist_ok=True)
catalog=[]
def entry(name,title,description,kind,expected='',source='Locally authored test script; MIT',family='controlled'):
 file=root/(name+'.pdf')
 catalog.append(dict(id=name,title=title,description=description,kind=kind,family=family,lab=True,source=source,pages=len(PdfReader(file).pages),sha256=hashlib.sha256(file.read_bytes()).hexdigest(),expectedText=expected))
def raster(source,target,variant='clean',pages=None):
 document=pdfium.PdfDocument(str(source)); c=canvas.Canvas(str(target))
 for i in pages or range(len(document)):
  page=document[i];w,h=page.get_size();image=page.render(scale=2.5 if variant!='low-resolution' else 1.25).to_pil().convert('RGB')
  if variant=='skew':image=image.rotate(1.8,resample=Image.Resampling.BICUBIC,expand=False,fillcolor='white')
  if variant=='faint':image=ImageEnhance.Contrast(image).enhance(.55)
  if variant=='blur':image=image.filter(ImageFilter.GaussianBlur(.55))
  if variant=='paper':
   overlay=Image.new('RGB',image.size,(242,235,214));image=Image.blend(image,overlay,.18)
  c.setPageSize((w,h));c.drawImage(ImageReader(image),0,0,width=w,height=h);c.showPage();page.close()
 c.save();document.close()

variants=['serif','sans','mono','large-type','small-type','columns','speaker-indent','verse','highlight','mixed-emphasis','wide','sparse']
for n,variant in enumerate(variants):
 name='layout-'+variant;w,h=(792,612) if variant=='wide' else (612,792)
 size=16 if variant=='large-type' else 9 if variant=='small-type' else 12
 family='Helvetica' if variant=='sans' else 'Courier' if variant=='mono' else 'Times'
 base='Times-Roman' if family=='Times' else family
 bold=family+'-Bold';italic=family+('-Italic' if family=='Times' else '-Oblique');both=family+('-BoldItalic' if family=='Times' else '-BoldOblique')
 c=canvas.Canvas(str(root/(name+'.pdf')),pagesize=(w,h));c.setTitle('The Lantern Room: '+variant)
 c.setFont(bold,size*1.5);c.drawCentredString(w/2,h-65,'ACT I. THE LANTERN ROOM')
 c.setFont(italic,size);c.drawString(85,h-105,'[A workshop. Rain taps against the windows.]')
 y=h-150; expected=['ACT I. THE LANTERN ROOM','[A workshop. Rain taps against the windows.]']
 speeches=[('MARA','The lantern is ready. Let us open the door.'),('ELI','Wait for the bell, then bring the light inside.'),('MARA','One small flame can fill this quiet room.'),('ELI','I hear the rain. The street is nearly empty.'),('MARA','Then we will leave the lantern by the window.'),('ELI','The bell has sounded. Now the show can start.')]
 if variant=='columns':
  for col in range(2):
   cy=y
   for speaker,text in speeches[:4]:
    c.setFont(bold,size);c.drawString(48+col*275,cy,speaker);cy-=size*1.5
    for line in [text[:text.rfind(' ',0,25)],text[text.rfind(' ',0,25)+1:]]:
     c.setFont(base,size);c.drawString(60+col*275,cy,line);cy-=size*1.5;expected.append(line)
    cy-=size*.8
 else:
  for j,(speaker,text) in enumerate(speeches):
   sx=48 if variant!='speaker-indent' else 135
   c.setFont(bold,size);c.drawString(sx,y,speaker);expected.append(speaker);y-=size*1.45
   x=78 if variant!='speaker-indent' else 108
   if variant=='highlight' and j==0:
    c.setFillColorRGB(1,.92,.3);c.rect(x-1,y-3,stringWidth(text,base,size)+3,size+5,fill=1,stroke=0);c.setFillColorRGB(0,0,0)
   if variant=='highlight' and j==1:
    c.highlightAnnotation('Rehearsal note',Rect=(x,y-3,x+stringWidth(text,base,size),y+size+2),Color=[.5,1,.6])
   if variant=='mixed-emphasis' and j in [1,2]:font=italic if j==1 else both
   else:font=base
   c.setFont(font,size)
   if variant=='verse':
    parts=['One small flame can fill this quiet room,','And cast its light along the empty street.']
    for k,line in enumerate(parts):c.drawString(x+k*15,y,line);expected.append(line);y-=size*1.45
   else:c.drawString(x,y,text);expected.append(text);y-=size*1.45
   y-=size*(2 if variant=='sparse' else .65)
 c.setFont(base,8);c.drawRightString(w-45,30,'1');expected.append('1');c.save()
 full='\n'.join(expected)
 entry(name,variant.replace('-',' ').title()+' · PDF','Digital: emphasis, indentation and cue anchors.','digital',full)
 scan_variant=['clean','paper','clean','skew','low-resolution','clean','clean','faint','clean','clean','blur','clean'][n]
 scan_name=name+'-scan';raster(root/(name+'.pdf'),root/(scan_name+'.pdf'),scan_variant)
 entry(scan_name,variant.replace('-',' ').title()+' · scan',f'Raster-only scan: {scan_variant}.','scan',full)

sources=json.loads((root/'sources/sources.json').read_text())
for source in sources:
 if 'error' in source:continue
 name=source['id'];reader=PdfReader(root/'sources'/(name+'.pdf'))
 if name.startswith('folger'):pages=[8,9,25] if 'macbeth' in name else [8,9,22]
 elif name.startswith('archive'):pages=[32,34,35]
 else:pages=[5,6,7]
 writer=PdfWriter();expected=[]
 for i in pages:
  if i<len(reader.pages):writer.add_page(reader.pages[i]);expected.append(reader.pages[i].extract_text() or '')
 target=root/(name+'.pdf')
 with target.open('wb') as f:writer.write(f)
 entry(name,name.replace('-',' ').title()+' · source','Three pages from a real edition; source recorded in catalog.','scan-with-text' if 'dolls-house' in name else 'digital','\n'.join(expected),source['url'],'published')
 scanned=name+'-scan';raster(target,root/(scanned+'.pdf'),'clean')
 entry(scanned,name.replace('-',' ').title()+' · raster','Raster-only counterpart for comparing OCR with embedded text.','scan','\n'.join(expected),source['url'],'published')
# These two archival text layers are corrupt, so they are not valid references.
# The snippets below were transcribed from the visible first excerpt page.
manual={
'ibsen-dolls-house':"A bell rings in the hall outside. Presently the outer door is heard to open. Then Nora enters, humming contentedly. She is in outdoor dress, and carries several parcels, which she lays on the right-hand table. She leaves the door into the hall open behind her, and a Porter is seen outside, carrying a Christmas-tree and a basket, which he gives to the maid-servant who has opened the door.",
'archive-dolls-house':"A room comfortably and tastefully, but not expensively, furnished. To the right a door leads to the Hall; to the left another door in the background to Helmer's study. Between the two doors a pianoforte. In the middle of the left wall, a door, and somewhat nearer the front a window. Near the window a round table with an arm-chair and a small sofa. In the right wall, somewhat to the back, a door."
}
for item in catalog:
 key=item['id'].removesuffix('-scan')
 if key in manual:item['expectedText']=manual[key];item['referenceScope']='Manually transcribed opening passage of page 1 only; remaining pages need visual review.'
 else:item['referenceScope']='Complete controlled script' if item['family']=='controlled' else 'Embedded source text'
(root/'catalog.json').write_text(json.dumps(catalog,indent=2)+'\n')
(root/'README.md').write_text('Local importer evaluation corpus\n\n'+str(len(catalog))+' test PDFs. Controlled layout cases are locally authored; published excerpts retain their source metadata. Rasterized variants are derived tests, not independent editions. No test PDFs are added to the product bundle.\n\nSource downloads and excerpts are for local evaluation. Review each edition\'s terms before redistribution.\n')
print(json.dumps({'cases':len(catalog),'pages':sum(i['pages'] for i in catalog),'digital':sum(i['kind']=='digital' for i in catalog),'scans':sum(i['kind'] in ['scan','scan-with-text'] for i in catalog)},indent=2))
