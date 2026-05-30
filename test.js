const IMG = new Image();
IMG.src = '이미지url';

// IMG.src 에 이미지 url을 넣으면 브라우저에서 이미지를 다운하게 되고 로드가 다되면 이벤트 발생
IMG.addEventListener('load', function() {
    console.log('높이 : ', this.naturalHeight , '너비 : ', this.naturalWidth, "이미지 : ", this.src);	
});