"""Rebuild bundled PDFs from the unchanged Project Gutenberg sources.

Requires reportlab, pypdf and PyMuPDF (fitz); these are build-time tools only.
"""
from pathlib import Path
import re, json, hashlib, io
from xml.sax.saxutils import escape
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Preformatted
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter
import tempfile, subprocess, shutil

root = Path(__file__).resolve().parent.parent / 'examples'
root.mkdir(exist_ok=True)
catalog = [
 dict(id='macbeth',title='Macbeth',author='William Shakespeare',source='https://www.gutenberg.org/ebooks/1533',description='Complete play. Verse, many scenes, and a serif layout.',font='Times-Roman',size=11),
 dict(id='earnest',title='The Importance of Being Earnest',author='Oscar Wilde',source='https://www.gutenberg.org/ebooks/844',description='Complete play. Dialogue, act headings, and a sans serif layout.',font='Helvetica',size=10),
]
def footer(c,doc):
 c.setFont('Helvetica',8);c.setFillColorRGB(.35,.35,.35)
 c.drawString(48,27,f'{doc.title} | public-domain example');c.drawRightString(564,27,str(doc.page))

for item in catalog:
 source=root/'sources'/f"{item['id']}.txt"
 raw=source.read_text(encoding='utf-8-sig')
 assert item['title'].lower() in raw[:500].lower()
 body=re.split(r'\*\*\* START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*',raw,flags=re.I)[1]
 body=re.split(r'\*\*\* END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK',body,flags=re.I)[0].strip()
 normal=ParagraphStyle('Body',fontName=item['font'],fontSize=item['size'],leading=item['size']*1.45,spaceAfter=7)
 heading=ParagraphStyle('Heading',parent=normal,fontName='Helvetica-Bold',fontSize=15,leading=20,spaceBefore=17,spaceAfter=12,keepWithNext=True)
 title=ParagraphStyle('Title',parent=heading,fontSize=27,leading=34,alignment=TA_CENTER,spaceAfter=25)
 story=[Spacer(1,100),Paragraph(escape(item['title']),title),Paragraph(escape(item['author']),ParagraphStyle('Author',parent=normal,alignment=TA_CENTER)),Spacer(1,35),Paragraph('Public-domain example for Lighting Design Desktop.',normal),Paragraph(f"Source: {escape(item['source'])}",normal),Paragraph('This PDF was typeset from the Project Gutenberg text. The unchanged source, its full license, and credits are bundled in the examples/sources folder. Review the source terms before reuse outside the United States.',normal),PageBreak()]
 for block in re.split(r'\n\s*\n',body):
  block=block.strip()
  if not block:continue
  is_heading=len(block)<150 and re.match(r'^(ACT\b|SCENE\b|FIRST ACT|SECOND ACT|THIRD ACT|FOURTH ACT|FIFTH ACT|PROLOGUE\b|EPILOGUE\b)',block,re.I)
  if is_heading:story.append(Paragraph(escape(block).replace('\n','<br/>'),heading))
  else:
   # Keep source line breaks in verse, but wrap paragraphs to fit the page.
   story.append(Paragraph(escape(block).replace('\n','<br/>'),normal))
 target=root/f"{item['id']}.pdf"
 doc=SimpleDocTemplate(str(target),pagesize=(612,792),leftMargin=48,rightMargin=48,topMargin=48,bottomMargin=48,title=item['title'],author=item['author'])
 doc.build(story,onFirstPage=footer,onLaterPages=footer)
 item['pages']=len(PdfReader(target).pages)
 item['sha256']=hashlib.sha256(target.read_bytes()).hexdigest()
 item['sourceSha256']=hashlib.sha256(source.read_bytes()).hexdigest()

# Raster-only excerpt: deliberately removes all text to exercise real OCR.

scan=root/'macbeth-scanned.pdf'
c=canvas.Canvas(str(scan),pagesize=(612,792));c.setTitle('Macbeth - scanned excerpt');c.setAuthor('William Shakespeare')
with tempfile.TemporaryDirectory() as temp:
 subprocess.run([shutil.which('pdftoppm') or 'pdftoppm','-f','3','-l','5','-r','126','-png',str(root/'macbeth.pdf'),str(Path(temp)/'scan')],check=True)
 for image in sorted(Path(temp).glob('scan-*.png')):
  c.drawImage(ImageReader(str(image)),0,0,width=612,height=792)
  c.showPage()
c.save()
catalog.append(dict(id='macbeth-scanned',title='Macbeth: scanned excerpt',author='William Shakespeare',source='https://www.gutenberg.org/ebooks/1533',description='Three raster-only pages for trying offline OCR. No embedded text layer.',pages=3,sha256=hashlib.sha256(scan.read_bytes()).hexdigest()))
(root/'catalog.json').write_text(json.dumps(catalog,indent=2)+'\n')
print(json.dumps([{k:i[k] for k in ('id','pages','sha256')} for i in catalog],indent=2))

fixtures=Path(__file__).resolve().parent.parent/'tests/fixtures'
fixtures.mkdir(parents=True,exist_ok=True)
mixed=PdfWriter();mixed.add_page(PdfReader(root/'macbeth.pdf').pages[2]);mixed.add_page(PdfReader(root/'macbeth-scanned.pdf').pages[0]);mixed.add_page(PdfReader(root/'earnest.pdf').pages[3].rotate(90))
with (fixtures/'mixed-rotated.pdf').open('wb') as stream:mixed.write(stream)
locked=PdfWriter();locked.add_page(PdfReader(root/'macbeth.pdf').pages[2]);locked.encrypt('test-only')
with (fixtures/'locked.pdf').open('wb') as stream:locked.write(stream)
